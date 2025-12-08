/**
 * ScriptExecutorEffector - Executes Lua scripts from agent actions
 *
 * FLEX Component (priority 300 - Effector) that:
 * 1. Watches for 'lua' action facets from agents
 * 2. Creates ScriptExecutionFacet and manages lifecycle
 * 3. Executes scripts in sandboxed Lua environment
 * 4. Yields on tool calls, waits for results
 * 5. Creates ScriptResultFacet on completion
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { Facet, hasStateAspect } from '../veil/types';
import { LuaSandbox, createLuaSandbox, LuaExecutionResult } from './lua-sandbox';
import { installBuiltins } from './builtins';
import {
  ScriptExecutionFacet,
  ScriptResultFacet,
  ToolCallResultFacet,
  ScriptExecutionConfig,
  IToolRegistry,
  createScriptExecutionFacet,
  createScriptResultFacet,
  createToolCallFacet,
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
 * State for a running script
 */
interface RunningScript {
  scriptId: string;
  agentId: string;
  agentName?: string;
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
}

/**
 * ScriptExecutorEffector manages Lua script execution lifecycle
 */
export class ScriptExecutorEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  private config: Required<ScriptExecutionConfig>;
  private runningScripts: Map<string, RunningScript> = new Map();
  private toolRegistry?: IToolRegistry;

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
    // Try to get tool registry from space references, fall back to global
    this.toolRegistry = this.getReference<IToolRegistry>('toolRegistry');
    if (!this.toolRegistry) {
      this.toolRegistry = getGlobalToolRegistry();
    }
  }

  onUnmount(): void {
    // Clean up all running scripts
    for (const [, script] of this.runningScripts) {
      if (script.timeoutHandle) {
        clearTimeout(script.timeoutHandle);
      }
      script.sandbox.destroy();
    }
    this.runningScripts.clear();
  }

  /**
   * FLEX execute - process frame for lua actions and tool results
   */
  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame?.deltas) return;

    // Track which deltas we've processed
    const processedDeltaIds = new Set<string>();

    // 1. Process new lua action facets from frame deltas
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'action') {
        processedDeltaIds.add(delta.facet.id);
        this.handleActionFacet(delta.facet);
      }
    }

    // 2. Process tool call results from frame deltas
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && isToolCallResultFacet(delta.facet)) {
        processedDeltaIds.add(delta.facet.id);
        this.handleToolCallResult(delta.facet);
      }
    }

    // 3. Also check VEIL state for tool-call-results we might have missed
    // (added by other components earlier in this frame)
    if (state?.facets) {
      for (const [facetId, facet] of state.facets) {
        if (isToolCallResultFacet(facet) && !processedDeltaIds.has(facetId)) {
          // Check if any running script is waiting for this
          for (const script of this.runningScripts.values()) {
            if (script.pendingToolCallId === facet.toolCallId && !script.needsResume && !script.completed) {
              this.handleToolCallResult(facet);
              break;
            }
          }
        }
      }
    }

    // 4. Process any scripts that need to start or resume
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

    // 5. Finalize completed scripts
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
        script.sandbox.destroy();
        this.runningScripts.delete(scriptId);
      }
    }
  }

  /**
   * Handle a new action facet - check if it's a lua script
   */
  private handleActionFacet(facet: Facet): void {
    if (!hasStateAspect(facet)) return;

    const actionState = facet.state as { toolName: string; parameters?: Record<string, any> };
    if (actionState.toolName !== 'lua') return;

    const params = actionState.parameters || {};
    const code = params.content as string;
    if (!code) {
      console.warn('[ScriptExecutor] Lua action has no content');
      return;
    }

    // Get agent info from facet
    const agentId = (facet as any).agentId || 'unknown';
    const agentName = (facet as any).agentName;

    // Calculate timeout
    let timeoutMs: number | null = this.config.defaultTimeoutMs;
    if (params.timeout !== undefined) {
      if (params.timeout === 0 || params.timeout === null) {
        if (this.config.allowNoTimeout) {
          timeoutMs = null;
        } else {
          console.warn('[ScriptExecutor] No-timeout scripts not allowed, using default');
        }
      } else {
        timeoutMs = Math.min(params.timeout, this.config.maxTimeoutMs);
      }
    }

    // Create script ID
    const scriptId = `script:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create sandbox
    const sandbox = createLuaSandbox();

    // Install built-in functions (log, json.encode/decode, etc.)
    installBuiltins(sandbox);

    // Register tools from registry
    if (this.toolRegistry) {
      for (const tool of this.toolRegistry.getTools()) {
        sandbox.registerTool(tool.name, (...args) => args);
      }
    }

    // Load the script
    try {
      sandbox.loadScript(code);
    } catch (error: any) {
      // Syntax error - create result immediately
      const resultId = `script-result:${Date.now()}`;
      this.addOperation({
        type: 'addFacet',
        facet: createScriptResultFacet(resultId, scriptId, {
          success: false,
          error: error.message,
          errorType: 'lua-error',
        }),
      });
      sandbox.destroy();
      return;
    }

    // Create script execution facet
    const scriptFacet = createScriptExecutionFacet(scriptId, code, agentId, {
      agentName,
      timeoutMs,
      parentScriptId: params.parentScriptId || null,
      status: 'pending',
    });

    // Add the script facet
    this.addOperation({ type: 'addFacet', facet: scriptFacet });

    // Emit script created event
    this.emit({
      topic: 'script:created',
      payload: {
        scriptId,
        parentScriptId: scriptFacet.parentScriptId,
      },
    });

    // Create running script entry
    const runningScript: RunningScript = {
      scriptId,
      agentId,
      agentName,
      code,
      timeoutMs,
      parentScriptId: params.parentScriptId || null,
      sandbox,
      needsStart: true,
      needsResume: false,
      completed: false,
    };

    // Set up timeout if configured
    if (timeoutMs !== null && timeoutMs > 0) {
      runningScript.timeoutHandle = setTimeout(() => {
        this.handleTimeout(scriptId);
      }, timeoutMs);
    }

    this.runningScripts.set(scriptId, runningScript);
  }

  /**
   * Start executing a script
   */
  private startScript(script: RunningScript): void {
    // Update status to running
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: { status: 'running' },
    });

    // Run the script
    this.runScript(script);
  }

  /**
   * Resume script execution after tool call
   */
  private resumeScript(script: RunningScript, resumeValue?: unknown): void {
    // Update status to running
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: {
        status: 'running',
        blockedOn: undefined,
      },
    });

    // Run the script with resume value
    this.runScript(script, resumeValue);
  }

  /**
   * Run the script (initial or resumed)
   */
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
      // Script finished
      script.completed = true;
      if (result.success) {
        script.result = {
          success: true,
          result: result.returnValue,
        };
      } else {
        script.result = {
          success: false,
          error: result.error || 'Unknown error',
          errorType: 'lua-error',
        };
      }
    } else if (result.success && script.sandbox.isToolCall(result.yieldValue)) {
      // Script yielded for tool call
      const toolCall = result.yieldValue as { name: string; args: unknown[] };
      this.handleToolCallYield(script, toolCall.name, toolCall.args);
    } else {
      // Unexpected yield
      script.completed = true;
      script.result = {
        success: false,
        error: 'Script yielded with invalid value',
        errorType: 'lua-error',
      };
    }
  }

  /**
   * Handle script yielding for a tool call
   */
  private handleToolCallYield(script: RunningScript, toolName: string, args: unknown[]): void {
    // Create tool call ID
    const toolCallId = `tool-call:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Update script status to blocked
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: {
        status: 'blocked',
        blockedOn: toolCallId,
      },
    });

    // Create tool call facet
    const toolCallFacet = createToolCallFacet(toolCallId, script.scriptId, toolName, args, 'pending');
    this.addOperation({ type: 'addFacet', facet: toolCallFacet });

    // Store pending tool call ID
    script.pendingToolCallId = toolCallId;

    // Emit tool call event
    this.emit({
      topic: 'tool-call:created',
      payload: {
        toolCallId,
        parentScriptId: script.scriptId,
        toolName,
      },
    });
  }

  /**
   * Handle tool call result - mark script for resume
   */
  private handleToolCallResult(resultFacet: ToolCallResultFacet): void {
    // Find the running script waiting for this tool call
    const scriptId = resultFacet.parentScriptId;
    const script = this.runningScripts.get(scriptId);

    if (!script) {
      // Script may have timed out or been cancelled
      return;
    }

    if (script.pendingToolCallId !== resultFacet.toolCallId) {
      // Not the tool call we're waiting for
      return;
    }

    // Clear pending tool call
    script.pendingToolCallId = undefined;

    // Mark for resume
    if (resultFacet.success) {
      script.needsResume = true;
      script.resumeValue = resultFacet.result;
    } else {
      // Tool call failed - complete script with error
      script.completed = true;
      script.result = {
        success: false,
        error: resultFacet.error || 'Tool call failed',
        errorType: 'tool-error',
      };
    }
  }

  /**
   * Handle script timeout
   */
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

  /**
   * Finalize a completed script (create result facet and emit event)
   */
  private finalizeScript(script: RunningScript): void {
    if (!script.result) return;

    // Update script status
    this.addOperation({
      type: 'rewriteFacet',
      id: script.scriptId,
      changes: {
        status: script.result.success ? 'completed' : 'error',
        blockedOn: undefined,
      },
    });

    // Create result facet
    const resultId = `script-result:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resultFacet = createScriptResultFacet(resultId, script.scriptId, script.result);
    this.addOperation({ type: 'addFacet', facet: resultFacet });

    // Emit completion event
    this.emit({
      topic: 'script:completed',
      payload: {
        scriptId: script.scriptId,
        success: script.result.success,
      },
    });
  }

  /**
   * Get currently executing scripts count
   */
  getPendingScriptCount(): number {
    return this.runningScripts.size;
  }

  /**
   * Check if a script is currently executing
   */
  isScriptPending(scriptId: string): boolean {
    return this.runningScripts.has(scriptId);
  }
}

/**
 * Create a new script executor with optional configuration
 */
export function createScriptExecutor(config?: ScriptExecutionConfig): ScriptExecutorEffector {
  return new ScriptExecutorEffector(config);
}
