/**
 * ScriptRunner - Executes Lua scripts with persistent session support
 *
 * FLEX Component (priority 300 - Effector) that:
 * 1. Watches for 'lua' action facets from agents
 * 2. Manages persistent Lua sessions (REPL mode)
 * 3. Executes scripts in sandboxed Lua environment
 * 4. Yields on tool calls, waits for results
 * 5. Handles session:* actions (open, close, list, inspect)
 * 6. Persists session VM states across snapshots using fengari's saveVM/restoreVM
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { ReadonlyVEILState } from '../spaces/component-types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { Facet, hasStateAspect } from '../veil/types';
import { LuaSandbox, createLuaSandbox, LuaExecutionResult } from './lua-sandbox';
import { installBuiltins } from './builtins';
import { persistable, persistent, Serializers } from '../persistence/decorators';
import {
  ScriptResultFacet,
  ToolCallResultFacet,
  ScriptExecutionConfig,
  IToolRegistry,
  createScriptExecutionFacet,
  createScriptResultFacet,
  createToolCallFacet,
  createActionResultFacet,
  isToolCallResultFacet,
} from './types';
import { getGlobalToolRegistry } from './tool-registry';

/**
 * Default configuration for script execution
 */
const DEFAULT_CONFIG: Required<ScriptExecutionConfig> = {
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 300000, // 5 minutes max
  allowNoTimeout: false,
};

/**
 * Default session timeout configuration
 */
const DEFAULT_SESSION_CONFIG = {
  idleTimeoutMs: 300000, // 5 minutes idle timeout
  maxLifetimeMs: 3600000, // 1 hour max lifetime
  warningBeforeMs: 30000, // 30 second warning before timeout
};

/**
 * State for a running script
 */
interface RunningScript {
  scriptId: string;
  agentId: string;
  agentName?: string;
  streamId?: string;
  streamType?: string;
  alias?: string;
  code: string;
  timeoutMs: number | null;
  parentScriptId: string | null;
  sandbox: LuaSandbox;
  pendingToolCallId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  needsStart: boolean;
  needsResume: boolean;
  resumeValue?: unknown;
  completed: boolean;
  result?: { success: true; result?: unknown } | { success: false; error: string; errorType?: ScriptResultFacet['errorType'] };
  // Session support
  sessionName?: string;
  isSessionScript: boolean;
}

/**
 * Runtime session state (not persisted directly)
 */
interface LuaSession {
  id: string;
  sandbox: LuaSandbox;
  createdAt: Date;
  lastActivityAt: Date;
  pendingScripts: Set<string>;
  status: 'active' | 'closing' | 'closed';
}

/**
 * Serialized session state for persistence
 */
interface SerializedSession {
  id: string;
  vmState: string; // Base64-encoded Uint8Array from saveVM
  toolNames: string[]; // Tools to re-register on restore
  createdAt: string;
  lastActivityAt: string;
}

/**
 * Custom serializer for session states using VM serialization
 */
const sessionStatesSerializer = Serializers.object<SerializedSession[]>(
  (states: SerializedSession[]) => states,
  (data: any) => data as SerializedSession[]
);

/**
 * ScriptRunner manages Lua script execution with integrated session support
 */
@persistable(1)
export class ScriptRunner extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  // Subscribe to all events (need to catch activation:completed, tool-call:completed, and action:created for session:*)
  topics: '*' = '*';

  private config: Required<ScriptExecutionConfig>;
  private sessionConfig = DEFAULT_SESSION_CONFIG;
  private runningScripts: Map<string, RunningScript> = new Map();
  private toolRegistry?: IToolRegistry;

  // Session management (merged from LuaSessionManager)
  private sessions: Map<string, LuaSession> = new Map();
  private sessionTimeouts: Map<string, { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout>; warning?: ReturnType<typeof setTimeout> }> = new Map();

  // Persisted session states
  @persistent({ serializer: sessionStatesSerializer })
  private sessionStates: SerializedSession[] = [];

  constructor(config: ScriptExecutionConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the tool registry (can be injected or resolved from space)
   */
  setToolRegistry(registry: IToolRegistry): void {
    this.toolRegistry = registry;
  }

  onMount(): void {
    this.ensureToolRegistry();

    // Restore sessions from persisted state
    console.log(`[ScriptExecutor] onMount called, sessionStates.length = ${this.sessionStates?.length ?? 'undefined'}`);
    if (this.sessionStates && this.sessionStates.length > 0) {
      console.log(`[ScriptExecutor] Restoring ${this.sessionStates.length} sessions: ${this.sessionStates.map(s => s.id).join(', ')}`);
      this.restoreSessions();
    }
  }

  onUnmount(): void {
    // Clean up all running scripts
    for (const [, script] of this.runningScripts) {
      if (script.timeoutHandle) {
        clearTimeout(script.timeoutHandle);
      }
      if (!script.isSessionScript) {
        script.sandbox.destroy();
      }
    }
    this.runningScripts.clear();

    // Clean up all sessions
    for (const [sessionId] of this.sessions) {
      this.closeSessionInternal(sessionId, 'shutdown');
    }
    this.sessions.clear();
    this.clearAllSessionTimeouts();
  }

  /**
   * Ensure tool registry is available
   */
  private ensureToolRegistry(): void {
    if (this.toolRegistry) return;

    this.toolRegistry = this.getReference<IToolRegistry>('toolRegistry');
    if (!this.toolRegistry) {
      this.toolRegistry = getGlobalToolRegistry();
    }
  }

  // ============================================
  // FLEX EXECUTE
  // ============================================

  execute(context: ExecutionContext): void {
    const { frame, state, event } = context;
    if (!frame?.deltas) return;

    // 1. Handle tool-call:completed events
    if (event?.topic === 'tool-call:completed') {
      this.handleToolCallCompletedEvent(event, state);
    }

    // 2. Process new action facets from frame deltas
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'action') {
        const actionState = (delta.facet as any).state as { toolName: string };
        if (actionState.toolName === 'lua') {
          this.handleLuaAction(delta.facet);
        } else if (actionState.toolName.startsWith('session:')) {
          this.handleSessionAction(delta.facet);
        }
      }
    }

    // 3. Process scripts that need to start or resume
    for (const [, script] of this.runningScripts) {
      if (script.completed) continue;

      if (script.needsStart) {
        script.needsStart = false;
        this.startScript(script);
      } else if (script.needsResume) {
        script.needsResume = false;
        this.resumeScript(script, script.resumeValue);
        script.resumeValue = undefined;
      }
    }

    // 4. Finalize completed scripts
    const completedScriptIds: string[] = [];
    for (const [scriptId, script] of this.runningScripts) {
      if (script.completed && script.result) {
        this.finalizeScript(script);
        completedScriptIds.push(scriptId);
      }
    }

    // Clean up completed scripts
    for (const scriptId of completedScriptIds) {
      const script = this.runningScripts.get(scriptId);
      if (script) {
        if (script.timeoutHandle) {
          clearTimeout(script.timeoutHandle);
        }

        if (script.isSessionScript && script.sessionName) {
          // Touch session to trigger serialization
          this.touchSession(script.sessionName);
        } else {
          script.sandbox.destroy();
        }

        this.runningScripts.delete(scriptId);
      }
    }

    // 5. Serialize sessions for persistence (on every frame to catch changes)
    this.serializeSessions();
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  /**
   * Get or create a session by name
   */
  private getOrCreateSession(name: string): LuaSession {
    let session = this.sessions.get(name);

    if (session) {
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

    session = {
      id: name,
      sandbox,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      pendingScripts: new Set(),
      status: 'active',
    };

    this.sessions.set(name, session);
    this.scheduleSessionTimeouts(name);

    console.log(`[ScriptExecutor] Created session '${name}'`);
    return session;
  }

  /**
   * Touch session to update activity timestamp
   */
  private touchSession(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.lastActivityAt = new Date();
      this.resetIdleTimeout(sessionName);
    }
  }

  /**
   * Close a session
   */
  private closeSessionInternal(name: string, reason: string): string[] {
    const session = this.sessions.get(name);
    if (!session) return [];

    session.status = 'closing';
    const interruptedScripts = Array.from(session.pendingScripts);

    this.clearSessionTimeouts(name);
    session.sandbox.destroy();
    this.sessions.delete(name);

    // Remove from persisted states
    this.sessionStates = this.sessionStates.filter(s => s.id !== name);

    console.log(`[ScriptExecutor] Closed session '${name}' (${reason})`);
    return interruptedScripts;
  }

  /**
   * Serialize all active sessions for persistence
   */
  private serializeSessions(): void {
    const newStates: SerializedSession[] = [];

    for (const session of this.sessions.values()) {
      if (session.status !== 'active') continue;

      try {
        const vmState = session.sandbox.saveState();
        const toolNames = Array.from(session.sandbox.getRegisteredTools());

        newStates.push({
          id: session.id,
          vmState: this.uint8ArrayToBase64(vmState),
          toolNames,
          createdAt: session.createdAt.toISOString(),
          lastActivityAt: session.lastActivityAt.toISOString(),
        });
      } catch (error: any) {
        console.error(`[ScriptExecutor] Failed to serialize session '${session.id}':`, error.message);
      }
    }

    this.sessionStates = newStates;
  }

  /**
   * Restore sessions from persisted state
   */
  private restoreSessions(): void {
    for (const state of this.sessionStates) {
      try {
        const vmState = this.base64ToUint8Array(state.vmState);
        const sandbox = LuaSandbox.restoreFromState(vmState, state.toolNames);

        const session: LuaSession = {
          id: state.id,
          sandbox,
          createdAt: new Date(state.createdAt),
          lastActivityAt: new Date(state.lastActivityAt),
          pendingScripts: new Set(),
          status: 'active',
        };

        this.sessions.set(state.id, session);
        this.scheduleSessionTimeouts(state.id);

        console.log(`[ScriptExecutor] Restored session '${state.id}'`);
      } catch (error: any) {
        console.error(`[ScriptExecutor] Failed to restore session '${state.id}':`, error.message);
      }
    }
  }

  // ============================================
  // SESSION TIMEOUT MANAGEMENT
  // ============================================

  private scheduleSessionTimeouts(name: string): void {
    this.clearSessionTimeouts(name);

    const timeouts: { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout>; warning?: ReturnType<typeof setTimeout> } = {};

    if (this.sessionConfig.idleTimeoutMs > 0) {
      timeouts.idle = setTimeout(() => {
        console.log(`[ScriptExecutor] Session '${name}' timed out due to inactivity`);
        this.closeSessionInternal(name, 'idle-timeout');
      }, this.sessionConfig.idleTimeoutMs);
    }

    if (this.sessionConfig.maxLifetimeMs > 0) {
      timeouts.max = setTimeout(() => {
        console.log(`[ScriptExecutor] Session '${name}' reached max lifetime`);
        this.closeSessionInternal(name, 'max-lifetime');
      }, this.sessionConfig.maxLifetimeMs);
    }

    this.sessionTimeouts.set(name, timeouts);
  }

  private resetIdleTimeout(name: string): void {
    const timeouts = this.sessionTimeouts.get(name);
    if (!timeouts) {
      this.scheduleSessionTimeouts(name);
      return;
    }

    if (timeouts.idle) clearTimeout(timeouts.idle);

    if (this.sessionConfig.idleTimeoutMs > 0) {
      timeouts.idle = setTimeout(() => {
        console.log(`[ScriptExecutor] Session '${name}' timed out due to inactivity`);
        this.closeSessionInternal(name, 'idle-timeout');
      }, this.sessionConfig.idleTimeoutMs);
    }
  }

  private clearSessionTimeouts(name: string): void {
    const timeouts = this.sessionTimeouts.get(name);
    if (timeouts) {
      if (timeouts.idle) clearTimeout(timeouts.idle);
      if (timeouts.max) clearTimeout(timeouts.max);
      if (timeouts.warning) clearTimeout(timeouts.warning);
      this.sessionTimeouts.delete(name);
    }
  }

  private clearAllSessionTimeouts(): void {
    for (const [name] of this.sessionTimeouts) {
      this.clearSessionTimeouts(name);
    }
  }

  // ============================================
  // SESSION ACTION HANDLING
  // ============================================

  private handleSessionAction(facet: Facet): void {
    if (!hasStateAspect(facet)) return;

    const actionState = facet.state as { toolName: string; parameters?: Record<string, any> };
    const params = actionState.parameters || {};
    const streamId = (facet as any).streamId;
    const streamType = (facet as any).streamType;
    const actionId = facet.id;

    switch (actionState.toolName) {
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

  private handleSessionOpen(actionId: string, params: Record<string, any>, streamId?: string, streamType?: string): void {
    const name = params.name as string;
    if (!name) {
      this.emitSessionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    try {
      const existing = this.sessions.has(name);
      const session = this.getOrCreateSession(name);

      this.emitSessionResult(actionId, {
        success: true,
        result: {
          sessionId: name,
          created: !existing,
          globals: session.sandbox.getUserGlobals(),
        },
      }, streamId, streamType);
    } catch (error: any) {
      this.emitSessionResult(actionId, { success: false, error: error.message }, streamId, streamType);
    }
  }

  private handleSessionClose(actionId: string, params: Record<string, any>, streamId?: string, streamType?: string): void {
    const name = params.name as string;
    if (!name) {
      this.emitSessionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    if (!this.sessions.has(name)) {
      this.emitSessionResult(actionId, { success: false, error: `Session '${name}' not found` }, streamId, streamType);
      return;
    }

    const interruptedScripts = this.closeSessionInternal(name, 'explicit');
    this.emitSessionResult(actionId, {
      success: true,
      result: { sessionId: name, interruptedScripts },
    }, streamId, streamType);
  }

  private handleSessionList(actionId: string, streamId?: string, streamType?: string): void {
    const sessions = Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
      pendingScriptCount: s.pendingScripts.size,
      status: s.status,
    }));

    this.emitSessionResult(actionId, { success: true, result: sessions }, streamId, streamType);
  }

  private handleSessionInspect(actionId: string, params: Record<string, any>, streamId?: string, streamType?: string): void {
    const name = params.name as string;
    if (!name) {
      this.emitSessionResult(actionId, { success: false, error: 'Session name is required' }, streamId, streamType);
      return;
    }

    const session = this.sessions.get(name);
    if (!session) {
      this.emitSessionResult(actionId, { success: false, error: `Session '${name}' not found` }, streamId, streamType);
      return;
    }

    this.emitSessionResult(actionId, {
      success: true,
      result: {
        sessionId: name,
        globals: session.sandbox.getUserGlobals(),
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        pendingScriptCount: session.pendingScripts.size,
      },
    }, streamId, streamType);
  }

  private emitSessionResult(
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
  // LUA SCRIPT EXECUTION
  // ============================================

  private handleLuaAction(facet: Facet): void {
    if (!hasStateAspect(facet)) return;

    const actionState = facet.state as { toolName: string; parameters?: Record<string, any>; alias?: string };
    this.ensureToolRegistry();

    const params = actionState.parameters || {};
    const code = params.content as string;
    if (!code) {
      console.warn('[ScriptExecutor] Lua action has no content');
      return;
    }

    const agentId = (facet as any).agentId || 'unknown';
    const agentName = (facet as any).agentName;
    const streamId = (facet as any).streamId;
    const streamType = (facet as any).streamType;
    const alias = actionState.alias || params.alias;
    const sessionName = params.session as string | undefined;

    let timeoutMs: number | null = this.config.defaultTimeoutMs;
    if (params.timeout !== undefined) {
      if (params.timeout === 0 || params.timeout === null) {
        if (this.config.allowNoTimeout) {
          timeoutMs = null;
        }
      } else {
        timeoutMs = Math.min(params.timeout, this.config.maxTimeoutMs);
      }
    }

    const scriptId = `script:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let sandbox: LuaSandbox;
    let isSessionScript = false;

    if (sessionName) {
      // Session-based execution
      try {
        const session = this.getOrCreateSession(sessionName);
        sandbox = session.sandbox;
        isSessionScript = true;
        session.pendingScripts.add(scriptId);
        console.log(`[ScriptExecutor] Using session '${sessionName}' for script ${scriptId}`);
      } catch (error: any) {
        console.error(`[ScriptExecutor] Failed to get/create session '${sessionName}':`, error.message);
        this.addOperation({
          type: 'addFacet',
          facet: createActionResultFacet(
            `action-result:${scriptId}`,
            scriptId,
            null,
            { success: false, error: `Session error: ${error.message}`, message: 'Failed to create session' },
            streamId,
            streamType,
            alias
          ),
        });
        return;
      }
    } else {
      // One-off execution
      sandbox = createLuaSandbox();
      installBuiltins(sandbox);

      if (this.toolRegistry) {
        const tools = this.toolRegistry.getTools();
        for (const tool of tools) {
          sandbox.registerTool(tool.name, (...args) => args);
        }
      }
    }

    // Load the script
    try {
      sandbox.loadScript(code);
    } catch (error: any) {
      this.addOperation({
        type: 'addFacet',
        facet: createScriptResultFacet(`script-result:${Date.now()}`, scriptId, {
          success: false,
          error: error.message,
          errorType: 'lua-error',
        }),
      });

      this.addOperation({
        type: 'addFacet',
        facet: createActionResultFacet(
          `action-result:${scriptId}`,
          scriptId,
          null,
          { success: false, error: error.message, message: 'Script syntax error' },
          streamId,
          streamType,
          alias
        ),
      });

      if (!isSessionScript) {
        sandbox.destroy();
      } else if (sessionName) {
        const session = this.sessions.get(sessionName);
        if (session) session.pendingScripts.delete(scriptId);
      }
      return;
    }

    // Create script execution facet
    const scriptFacet = createScriptExecutionFacet(scriptId, code, agentId, {
      agentName,
      timeoutMs,
      parentScriptId: params.parentScriptId || null,
      status: 'pending',
    });

    this.addOperation({ type: 'addFacet', facet: scriptFacet });

    this.emit({
      topic: 'script:created',
      payload: { scriptId, parentScriptId: scriptFacet.parentScriptId },
    });

    const runningScript: RunningScript = {
      scriptId,
      agentId,
      agentName,
      streamId,
      streamType,
      alias,
      code,
      timeoutMs,
      parentScriptId: params.parentScriptId || null,
      sandbox,
      needsStart: true,
      needsResume: false,
      completed: false,
      sessionName,
      isSessionScript,
    };

    if (timeoutMs !== null && timeoutMs > 0) {
      runningScript.timeoutHandle = setTimeout(() => {
        this.handleTimeout(scriptId);
      }, timeoutMs);
    }

    this.runningScripts.set(scriptId, runningScript);
  }

  private handleToolCallCompletedEvent(event: any, state: ReadonlyVEILState): void {
    const { toolCallId, parentScriptId, success } = event.payload || {};
    if (!toolCallId || !parentScriptId) return;

    const script = this.runningScripts.get(parentScriptId);
    if (!script || script.pendingToolCallId !== toolCallId) return;

    const resultFacet = this.findToolCallResultFacet(toolCallId, state);
    script.pendingToolCallId = undefined;

    if (resultFacet && resultFacet.success) {
      script.needsResume = true;
      script.resumeValue = resultFacet.result;
    } else if (resultFacet) {
      script.completed = true;
      script.result = {
        success: false,
        error: resultFacet.error || 'Tool call failed',
        errorType: 'tool-error',
      };
    } else {
      if (success) {
        script.needsResume = true;
        script.resumeValue = undefined;
      } else {
        script.completed = true;
        script.result = {
          success: false,
          error: 'Tool call failed (no result facet)',
          errorType: 'tool-error',
        };
      }
    }
  }

  private findToolCallResultFacet(toolCallId: string, state: ReadonlyVEILState): ToolCallResultFacet | undefined {
    if (!state?.facets) return undefined;

    for (const facet of state.facets.values()) {
      if (isToolCallResultFacet(facet) && facet.toolCallId === toolCallId) {
        return facet;
      }
    }
    return undefined;
  }

  private startScript(script: RunningScript): void {
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: { status: 'running' },
    });
    this.runScript(script);
  }

  private resumeScript(script: RunningScript, resumeValue?: unknown): void {
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: { status: 'running', blockedOn: undefined },
    });
    this.runScript(script, resumeValue);
  }

  private runScript(script: RunningScript, resumeValue?: unknown): void {
    let result: LuaExecutionResult;
    try {
      result = script.sandbox.run(resumeValue);
    } catch (error: any) {
      script.completed = true;
      script.result = {
        success: false,
        error: error.message,
        errorType: 'lua-error',
      };
      return;
    }

    if (result.completed) {
      script.completed = true;
      if (result.success) {
        script.result = { success: true, result: result.returnValue };
      } else {
        script.result = {
          success: false,
          error: result.error || 'Unknown error',
          errorType: 'lua-error',
        };
      }
    } else if (result.success && script.sandbox.isToolCall(result.yieldValue)) {
      const toolCall = result.yieldValue as { name: string; args: unknown[] };
      this.handleToolCallYield(script, toolCall.name, toolCall.args);
    } else {
      script.completed = true;
      script.result = {
        success: false,
        error: 'Script yielded with invalid value',
        errorType: 'lua-error',
      };
    }
  }

  private handleToolCallYield(script: RunningScript, toolName: string, args: unknown[]): void {
    const toolCallId = `tool-call:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: { status: 'blocked', blockedOn: toolCallId },
    });

    const toolCallFacet = createToolCallFacet(toolCallId, script.scriptId, toolName, args, 'pending');
    this.addOperation({ type: 'addFacet', facet: toolCallFacet });

    script.pendingToolCallId = toolCallId;

    this.emit({
      topic: 'tool-call:created',
      payload: { toolCallId, parentScriptId: script.scriptId, toolName },
    });
  }

  private handleTimeout(scriptId: string): void {
    const script = this.runningScripts.get(scriptId);
    if (!script || script.completed) return;

    script.completed = true;
    script.result = {
      success: false,
      error: 'Script execution timed out',
      errorType: 'timeout',
    };
  }

  private finalizeScript(script: RunningScript): void {
    if (!script.result) return;

    // Remove from session pending scripts
    if (script.isSessionScript && script.sessionName) {
      const session = this.sessions.get(script.sessionName);
      if (session) {
        session.pendingScripts.delete(script.scriptId);
      }
    }

    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: {
        status: script.result.success ? 'completed' : 'error',
        blockedOn: undefined,
      },
    });

    const actionResultFacet = createActionResultFacet(
      `action-result:${script.scriptId}`,
      script.scriptId,
      null,
      script.result.success
        ? { success: true, result: (script.result as any).result, message: 'Script completed' }
        : { success: false, error: (script.result as any).error || 'Script failed', message: 'Script failed' },
      script.streamId,
      script.streamType,
      script.alias
    );
    this.addOperation({ type: 'addFacet', facet: actionResultFacet });

    const resultFacet = createScriptResultFacet(
      `script-result:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      script.scriptId,
      script.result
    );
    this.addOperation({ type: 'addFacet', facet: resultFacet });
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ============================================
  // PUBLIC API
  // ============================================

  getPendingScriptCount(): number {
    return this.runningScripts.size;
  }

  isScriptPending(scriptId: string): boolean {
    return this.runningScripts.has(scriptId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }
}

/**
 * Create a new script executor with optional configuration
 */
export function createScriptExecutor(config?: ScriptExecutionConfig): ScriptRunner {
  return new ScriptRunner(config);
}
