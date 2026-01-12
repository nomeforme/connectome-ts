/**
 * LuaSessionManager - Manages persistent Lua REPL sessions
 *
 * FLEX Component (priority 300 - Effector) that:
 * 1. Manages named Lua sessions that persist state between script calls
 * 2. Handles session:open, session:close, session:list, session:inspect actions
 * 3. Persists session state across snapshots
 * 4. Auto-closes sessions after idle timeout
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { Facet, hasStateAspect } from '../veil/types';
import { persistable, persistent, Serializers } from '../persistence/decorators';
import { LuaSandbox, createLuaSandbox } from './lua-sandbox';
import { installBuiltins } from './builtins';
import { getGlobalToolRegistry, ToolRegistry } from './tool-registry';
import {
  LuaSession,
  SerializedSessionState,
  SessionMetadata,
  SessionTimeoutConfig,
  DEFAULT_SESSION_TIMEOUT_CONFIG,
  createSessionOpenedFacet,
  createSessionClosedFacet,
  createSessionRestoredFacet,
  createSessionTimeoutWarningFacet,
} from './session-types';
import { createActionResultFacet } from './types';

/**
 * Custom serializer for session states
 */
const sessionStatesSerializer = Serializers.object<SerializedSessionState[]>(
  // serialize: already in correct format
  (states: SerializedSessionState[]) => states,
  // deserialize: parse back
  (data: any) => data as SerializedSessionState[]
);

/**
 * LuaSessionManager manages persistent Lua sessions
 */
@persistable(1)
export class LuaSessionManager extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  // Watch for all events - sessions can be created via ScriptExecutor on any frame
  // Also handles session:* actions from action:created events
  topics: '*' = '*';

  // Runtime state (not persisted directly)
  private sessions: Map<string, LuaSession> = new Map();
  private timeouts: Map<string, { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout>; warning?: ReturnType<typeof setTimeout> }> = new Map();
  private toolRegistry?: ToolRegistry;

  // Persisted state
  @persistent({ serializer: sessionStatesSerializer })
  private sessionStates: SerializedSessionState[] = [];

  // Configuration
  private config: SessionTimeoutConfig;

  constructor(config?: Partial<SessionTimeoutConfig>) {
    super();
    this.config = { ...DEFAULT_SESSION_TIMEOUT_CONFIG, ...config };
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  onMount(): void {
    this.toolRegistry = this.getReference<ToolRegistry>('toolRegistry') || getGlobalToolRegistry();

    // Restore sessions from persisted state
    if (this.sessionStates.length > 0) {
      this.restoreSessions();
    }
  }

  onUnmount(): void {
    // Clean up all sessions and timeouts
    for (const [sessionId] of this.sessions) {
      this.closeSessionInternal(sessionId, 'shutdown', false);
    }
    this.sessions.clear();
    this.clearAllTimeouts();
  }

  // ============================================
  // FLEX EXECUTE
  // ============================================

  execute(context: ExecutionContext): void {
    const { frame } = context;
    if (!frame?.deltas) return;

    // Process session:* action facets
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'action') {
        this.handleActionFacet(delta.facet);
      }
    }

    // Serialize sessions before persistence (called on every frame, but cheap if no changes)
    this.serializeSessions();
  }

  private handleActionFacet(facet: Facet): void {
    if (!hasStateAspect(facet)) return;

    const actionState = facet.state as { toolName: string; parameters?: Record<string, any> };
    const toolName = actionState.toolName;

    // Only handle session:* actions
    if (!toolName.startsWith('session:')) return;

    const params = actionState.parameters || {};
    const actionId = facet.id;
    const streamId = (facet as any).streamId;
    const streamType = (facet as any).streamType;

    switch (toolName) {
      case 'session:open':
        this.handleSessionOpen(actionId, params, streamId, streamType);
        break;
      case 'session:close':
        this.handleSessionClose(actionId, params, streamId, streamType);
        break;
      case 'session:list':
        this.handleSessionList(actionId, streamId, streamType);
        break;
      case 'session:inspect':
        this.handleSessionInspect(actionId, params, streamId, streamType);
        break;
    }
  }

  // ============================================
  // SESSION ACTION HANDLERS
  // ============================================

  private handleSessionOpen(
    actionId: string,
    params: Record<string, any>,
    streamId?: string,
    streamType?: string
  ): void {
    const name = params.name as string;
    if (!name) {
      this.emitActionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    const initScript = params.initScript as string | undefined;
    const existing = this.sessions.has(name);

    try {
      const session = this.getOrCreateSession(name, initScript);

      // Emit session-opened facet
      this.addOperation({
        type: 'addFacet',
        facet: createSessionOpenedFacet(
          `session-opened:${name}:${Date.now()}`,
          name,
          !existing,
          !!initScript
        ),
      });

      this.emitActionResult(
        actionId,
        {
          success: true,
          result: {
            sessionId: name,
            created: !existing,
            globals: session.sandbox.getUserGlobals(),
          },
        },
        streamId,
        streamType
      );
    } catch (error: any) {
      this.emitActionResult(
        actionId,
        { success: false, error: `Failed to open session: ${error.message}` },
        streamId,
        streamType
      );
    }
  }

  private handleSessionClose(
    actionId: string,
    params: Record<string, any>,
    streamId?: string,
    streamType?: string
  ): void {
    const name = params.name as string;
    if (!name) {
      this.emitActionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    if (!this.sessions.has(name)) {
      this.emitActionResult(actionId, { success: false, error: `Session '${name}' not found` }, streamId, streamType);
      return;
    }

    const interruptedScripts = this.closeSession(name, 'explicit');

    this.emitActionResult(
      actionId,
      {
        success: true,
        result: {
          sessionId: name,
          interruptedScripts,
        },
      },
      streamId,
      streamType
    );
  }

  private handleSessionList(actionId: string, streamId?: string, streamType?: string): void {
    const sessions = this.listSessions();

    this.emitActionResult(
      actionId,
      {
        success: true,
        result: sessions,
      },
      streamId,
      streamType
    );
  }

  private handleSessionInspect(
    actionId: string,
    params: Record<string, any>,
    streamId?: string,
    streamType?: string
  ): void {
    const name = params.name as string;
    if (!name) {
      this.emitActionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    const session = this.sessions.get(name);
    if (!session) {
      this.emitActionResult(actionId, { success: false, error: `Session '${name}' not found` }, streamId, streamType);
      return;
    }

    const globals = session.sandbox.serializeGlobals();
    const userGlobalNames = session.sandbox.getUserGlobals();

    this.emitActionResult(
      actionId,
      {
        success: true,
        result: {
          sessionId: name,
          globals: userGlobalNames,
          state: globals,
          createdAt: session.createdAt.toISOString(),
          lastActivityAt: session.lastActivityAt.toISOString(),
          pendingScriptCount: session.pendingScripts.size,
        },
      },
      streamId,
      streamType
    );
  }

  private emitActionResult(
    actionId: string,
    outcome: { success: true; result?: unknown } | { success: false; error: string },
    streamId?: string,
    streamType?: string
  ): void {
    const resultId = `action-result:${actionId}`;
    this.addOperation({
      type: 'addFacet',
      facet: createActionResultFacet(
        resultId,
        actionId,
        null,
        outcome.success
          ? { success: true, result: outcome.result, message: 'Session action completed' }
          : { success: false, error: outcome.error, message: 'Session action failed' },
        streamId,
        streamType
      ),
    });
  }

  // ============================================
  // SESSION CRUD (PUBLIC API)
  // ============================================

  /**
   * Get or create a session by name.
   * If initScript is provided and session is new, run it.
   */
  getOrCreateSession(name: string, initScript?: string): LuaSession {
    let session = this.sessions.get(name);

    if (session) {
      // Update last activity
      session.lastActivityAt = new Date();
      this.resetIdleTimeout(name);
      return session;
    }

    // Create new session
    const sandbox = createLuaSandbox();
    installBuiltins(sandbox);

    // Register tools
    if (this.toolRegistry) {
      const tools = this.toolRegistry.getTools();
      for (const tool of tools) {
        sandbox.registerTool(tool.name, (...args) => args);
      }
    }

    // Run init script if provided
    if (initScript) {
      try {
        sandbox.loadScript(initScript);
        const result = sandbox.run();
        if (!result.success) {
          sandbox.destroy();
          throw new Error(`Init script failed: ${result.error}`);
        }
      } catch (error: any) {
        sandbox.destroy();
        throw error;
      }
    }

    session = {
      id: name,
      sandbox,
      initScript,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      pendingScripts: new Set(),
      status: 'active',
    };

    this.sessions.set(name, session);
    this.scheduleTimeouts(name);

    // Serialize immediately so persistence captures the new session
    this.serializeSessions();

    return session;
  }

  /**
   * Get an existing session by name
   */
  getSession(name: string): LuaSession | undefined {
    return this.sessions.get(name);
  }

  /**
   * Close a session and clean up resources
   */
  closeSession(name: string, reason: 'explicit' | 'timeout' | 'error' | 'shutdown'): string[] {
    return this.closeSessionInternal(name, reason, true);
  }

  private closeSessionInternal(
    name: string,
    reason: 'explicit' | 'timeout' | 'error' | 'shutdown',
    emitFacet: boolean
  ): string[] {
    const session = this.sessions.get(name);
    if (!session) return [];

    session.status = 'closing';

    // Get interrupted scripts
    const interruptedScripts = Array.from(session.pendingScripts);

    // Clear timeouts
    this.clearTimeouts(name);

    // Destroy sandbox
    session.sandbox.destroy();

    // Remove from sessions
    this.sessions.delete(name);

    // Remove from persisted state
    this.sessionStates = this.sessionStates.filter(s => s.id !== name);

    session.status = 'closed';

    // Emit session-closed facet
    if (emitFacet) {
      this.addOperation({
        type: 'addFacet',
        facet: createSessionClosedFacet(
          `session-closed:${name}:${Date.now()}`,
          name,
          reason,
          interruptedScripts.length > 0 ? interruptedScripts : undefined
        ),
      });
    }

    return interruptedScripts;
  }

  /**
   * List all active sessions
   */
  listSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      pendingScriptCount: session.pendingScripts.size,
      status: session.status,
    }));
  }

  /**
   * Inspect a session's state
   */
  inspectSession(name: string): Record<string, unknown> | undefined {
    const session = this.sessions.get(name);
    if (!session) return undefined;
    return session.sandbox.serializeGlobals();
  }

  // ============================================
  // SCRIPT TRACKING (called by ScriptExecutor)
  // ============================================

  /**
   * Register a script as running in a session
   */
  registerScript(sessionName: string, scriptId: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.pendingScripts.add(scriptId);
      this.touchSession(sessionName);
    }
  }

  /**
   * Unregister a script from a session
   */
  unregisterScript(sessionName: string, scriptId: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.pendingScripts.delete(scriptId);
      this.touchSession(sessionName);
    }
  }

  /**
   * Update session activity timestamp
   */
  touchSession(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.lastActivityAt = new Date();
      this.resetIdleTimeout(sessionName);
      // Serialize after activity - captures any state changes from script execution
      this.serializeSessions();
    }
  }

  // ============================================
  // TIMEOUT MANAGEMENT
  // ============================================

  private scheduleTimeouts(name: string): void {
    this.clearTimeouts(name);

    const timeouts: { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout>; warning?: ReturnType<typeof setTimeout> } = {};

    // Idle timeout with warning
    if (this.config.idleTimeoutMs > 0) {
      const warningTime = Math.max(0, this.config.idleTimeoutMs - this.config.warningBeforeMs);

      if (this.config.warningBeforeMs > 0 && warningTime > 0) {
        timeouts.warning = setTimeout(() => {
          this.emitTimeoutWarning(name, Math.ceil(this.config.warningBeforeMs / 1000));
        }, warningTime);
      }

      timeouts.idle = setTimeout(() => {
        this.handleIdleTimeout(name);
      }, this.config.idleTimeoutMs);
    }

    // Max lifetime timeout
    if (this.config.maxLifetimeMs > 0) {
      timeouts.max = setTimeout(() => {
        this.handleMaxLifetimeTimeout(name);
      }, this.config.maxLifetimeMs);
    }

    this.timeouts.set(name, timeouts);
  }

  private resetIdleTimeout(name: string): void {
    const timeouts = this.timeouts.get(name);
    if (!timeouts) {
      this.scheduleTimeouts(name);
      return;
    }

    // Clear idle and warning timeouts
    if (timeouts.idle) clearTimeout(timeouts.idle);
    if (timeouts.warning) clearTimeout(timeouts.warning);

    // Reschedule idle timeout
    if (this.config.idleTimeoutMs > 0) {
      const warningTime = Math.max(0, this.config.idleTimeoutMs - this.config.warningBeforeMs);

      if (this.config.warningBeforeMs > 0 && warningTime > 0) {
        timeouts.warning = setTimeout(() => {
          this.emitTimeoutWarning(name, Math.ceil(this.config.warningBeforeMs / 1000));
        }, warningTime);
      }

      timeouts.idle = setTimeout(() => {
        this.handleIdleTimeout(name);
      }, this.config.idleTimeoutMs);
    }
  }

  private clearTimeouts(name: string): void {
    const timeouts = this.timeouts.get(name);
    if (timeouts) {
      if (timeouts.idle) clearTimeout(timeouts.idle);
      if (timeouts.max) clearTimeout(timeouts.max);
      if (timeouts.warning) clearTimeout(timeouts.warning);
      this.timeouts.delete(name);
    }
  }

  private clearAllTimeouts(): void {
    for (const [name] of this.timeouts) {
      this.clearTimeouts(name);
    }
  }

  private handleIdleTimeout(name: string): void {
    console.log(`[LuaSessionManager] Session '${name}' timed out due to inactivity`);
    this.closeSession(name, 'timeout');
  }

  private handleMaxLifetimeTimeout(name: string): void {
    console.log(`[LuaSessionManager] Session '${name}' reached max lifetime`);
    this.closeSession(name, 'timeout');
  }

  private emitTimeoutWarning(name: string, secondsRemaining: number): void {
    this.addOperation({
      type: 'addFacet',
      facet: createSessionTimeoutWarningFacet(
        `session-timeout-warning:${name}:${Date.now()}`,
        name,
        secondsRemaining
      ),
    });
  }

  // ============================================
  // PERSISTENCE
  // ============================================

  /**
   * Serialize all active sessions for persistence
   */
  private serializeSessions(): void {
    this.sessionStates = Array.from(this.sessions.values())
      .filter(s => s.status === 'active')
      .map(session => ({
        id: session.id,
        globals: session.sandbox.serializeGlobals(),
        initScript: session.initScript,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      }));
  }

  /**
   * Restore sessions from persisted state
   */
  private restoreSessions(): void {
    for (const state of this.sessionStates) {
      try {
        // Create sandbox
        const sandbox = createLuaSandbox();
        installBuiltins(sandbox);

        // Register tools
        if (this.toolRegistry) {
          const tools = this.toolRegistry.getTools();
          for (const tool of tools) {
            sandbox.registerTool(tool.name, (...args) => args);
          }
        }

        // Run init script if present
        let ranInitScript = false;
        if (state.initScript) {
          try {
            sandbox.loadScript(state.initScript);
            const result = sandbox.run();
            ranInitScript = result.success;
            if (!result.success) {
              console.warn(`[LuaSessionManager] Init script failed for session '${state.id}': ${result.error}`);
            }
          } catch (error: any) {
            console.warn(`[LuaSessionManager] Init script error for session '${state.id}': ${error.message}`);
          }
        }

        // Inject serialized globals
        sandbox.injectGlobals(state.globals);
        const restoredGlobalCount = Object.keys(state.globals).length;

        // Create session
        const session: LuaSession = {
          id: state.id,
          sandbox,
          initScript: state.initScript,
          createdAt: new Date(state.createdAt),
          lastActivityAt: new Date(state.lastActivityAt),
          pendingScripts: new Set(), // Scripts don't survive restore
          status: 'active',
        };

        this.sessions.set(state.id, session);
        this.scheduleTimeouts(state.id);

        // Emit session-restored facet
        this.addOperation({
          type: 'addFacet',
          facet: createSessionRestoredFacet(
            `session-restored:${state.id}:${Date.now()}`,
            state.id,
            ranInitScript,
            restoredGlobalCount
          ),
        });

        console.log(`[LuaSessionManager] Restored session '${state.id}' with ${restoredGlobalCount} globals`);
      } catch (error: any) {
        console.error(`[LuaSessionManager] Failed to restore session '${state.id}': ${error.message}`);
      }
    }
  }

  // ============================================
  // PUBLIC ACCESSORS
  // ============================================

  /**
   * Check if a session exists
   */
  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the tool registry
   */
  getToolRegistry(): ToolRegistry | undefined {
    return this.toolRegistry;
  }
}

/**
 * Create a new LuaSessionManager with optional configuration
 */
export function createLuaSessionManager(config?: Partial<SessionTimeoutConfig>): LuaSessionManager {
  return new LuaSessionManager(config);
}
