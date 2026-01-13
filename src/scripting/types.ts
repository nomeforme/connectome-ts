/**
 * Lua Scripting System Types
 *
 * This module defines types for the Lua scripting system, which allows agents
 * to chain multiple tool calls in a single action without round-trips through the LLM.
 *
 * Design: Immutable action facets + separate result facets
 * - Action facets represent requests (what was asked)
 * - Result facets represent outcomes (what happened)
 * - Attribution via ID references
 * - Events notify of state changes; facets are the source of truth
 */

import type { BaseFacet, AgentGeneratedAspect } from '../veil/facet-types';
import type { ToolInvocationMode } from '../agent/types';

// Re-export for convenience
export type { ToolInvocationMode };

// ============================================
// ACTION STATUS
// ============================================

/**
 * Lifecycle status for script and tool executions.
 * Tracked in the action facet (mutable).
 */
export type ActionStatus =
  | 'pending'      // Created but not yet started
  | 'running'      // Actively executing
  | 'blocked'      // Waiting for a child action to complete
  | 'completed'    // Finished (result in separate facet)
  | 'error';       // Failed (error in separate facet)

// ============================================
// SCRIPT EXECUTION FACETS
// ============================================

/**
 * A Lua script execution.
 *
 * The `status` field is mutable and tracks lifecycle.
 * The actual result/error is in a separate ScriptResultFacet.
 */
export type ScriptExecutionFacet = BaseFacet & AgentGeneratedAspect & {
  type: 'script-execution';

  /** The Lua source code */
  code: string;

  /** Timeout in milliseconds (0 or undefined = default, null = no timeout) */
  timeoutMs?: number | null;

  /**
   * Parent script ID if this script was spawned by another script.
   * null for agent-initiated scripts.
   */
  parentScriptId: string | null;

  /** Current execution status (mutable) */
  status: ActionStatus;

  /** If blocked, the tool call ID we're waiting for */
  blockedOn?: string;
};

/**
 * Result of a script execution.
 *
 * Created when a script completes (successfully or with error).
 * The existence of this facet indicates the script has finished.
 */
export type ScriptResultFacet = BaseFacet & {
  type: 'script-result';

  /** The script this result belongs to */
  scriptId: string;

  /** Whether the script completed successfully */
  success: boolean;

  /** Return value (when success=true) */
  result?: unknown;

  /** Error message (when success=false) */
  error?: string;

  /** Error type for categorization */
  errorType?: 'lua-error' | 'timeout' | 'interrupted' | 'tool-error';
};

// ============================================
// TOOL CALL FACETS
// ============================================

/**
 * A tool call spawned by a script.
 *
 * The `status` field is mutable and tracks lifecycle.
 * The actual result/error is in a separate ToolCallResultFacet.
 */
export type ToolCallFacet = BaseFacet & {
  type: 'tool-call';

  /** The script that spawned this tool call */
  parentScriptId: string;

  /** Name of the tool being called */
  toolName: string;

  /** Arguments passed to the tool */
  args: unknown[];

  /** Current execution status (mutable) */
  status: ActionStatus;
};

/**
 * Result of a tool call.
 *
 * Created when a tool call completes (successfully or with error).
 * The existence of this facet indicates the tool call has finished.
 */
export type ToolCallResultFacet = BaseFacet & {
  type: 'tool-call-result';

  /** The tool call this result belongs to */
  toolCallId: string;

  /** Denormalized: the script that spawned the tool call */
  parentScriptId: string;

  /** Whether the tool call succeeded */
  success: boolean;

  /** Return value (when success=true) */
  result?: unknown;

  /** Error message (when success=false) */
  error?: string;
};

// ============================================
// GENERIC ACTION/RESULT (for non-script tools)
// ============================================

/**
 * Generic action request facet.
 *
 * Can be used by any component to request an action and track its result.
 * This generalizes the script/tool-call pattern for broader use.
 *
 * The `status` field is mutable and tracks lifecycle.
 * The actual result/error is in a separate ActionResultFacet.
 */
export type ActionRequestFacet = BaseFacet & {
  type: 'action-request';

  /** Action name/type */
  actionName: string;

  /** Action parameters */
  params?: Record<string, unknown>;

  /** Parent action ID for nested actions (null for top-level) */
  parentActionId: string | null;

  /** Optional: which component should handle this */
  targetHandler?: string;

  /** Current execution status (mutable) */
  status: ActionStatus;

  /** If blocked, the child action ID we're waiting for */
  blockedOn?: string;
};

/**
 * Generic action result facet.
 *
 * Created when an action completes. Can be used to formalize
 * the existing ad-hoc patterns (e.g., channel-joined after join-channel).
 */
export type ActionResultFacet = BaseFacet & {
  type: 'action-result';

  /** The action this result belongs to */
  actionId: string;

  /** Denormalized parent for easier querying */
  parentActionId: string | null;

  /** Whether the action succeeded */
  success: boolean;

  /** Return value or relevant data */
  result?: unknown;

  /** Error message if failed */
  error?: string;

  /** Human-readable description of what happened */
  message?: string;

  /** Stream context from the original action (for routing agent response) */
  streamId?: string;

  /** Stream type for proper routing (e.g., 'discord') */
  streamType?: string;
};

// ============================================
// TOOL MODE CONTROL
// ============================================

/**
 * Facet that controls the invocation mode for a specific tool.
 *
 * This allows agents or other space participants to dynamically change
 * how a tool is invoked at runtime. The mode persists as system state
 * until changed or expired.
 *
 * Usage:
 * - Agent calls setToolMode("discord.send", "programmatic") to batch Discord sends
 * - Human participant sets mode to control agent behavior
 * - Mode preferences are resolved with priority (higher wins)
 */
export type ToolModePreferenceFacet = BaseFacet & {
  type: 'tool-mode-preference';

  /**
   * Tool name this preference applies to.
   * Use '*' to set a default mode for all tools.
   */
  toolName: string;

  /**
   * Desired invocation mode for this tool.
   * - 'native': Execute immediately, each call can trigger agent re-activation
   * - 'programmatic': Better for Lua batching, only final result triggers re-activation
   */
  preferredMode: ToolInvocationMode;

  /**
   * Who set this preference (agent ID, participant ID, or system identifier)
   */
  setBy: string;

  /**
   * Priority for conflict resolution. Higher priority wins.
   * Suggested ranges:
   * - 0-50: System defaults
   * - 51-100: Agent preferences
   * - 101-200: Human/participant overrides
   * Default: 50
   */
  priority?: number;

  /**
   * Optional expiration timestamp (milliseconds since epoch).
   * If set, preference is ignored after this time.
   */
  expiresAt?: number;

  /**
   * Optional: applies only to a specific agent.
   * If undefined, applies to all agents in the space.
   */
  targetAgentId?: string;
};

// ============================================
// EVENTS
// ============================================

/**
 * Emitted when a script execution is created
 */
export interface ScriptCreatedEvent {
  topic: 'script:created';
  scriptId: string;
  parentScriptId: string | null;
}

/**
 * Emitted when a script completes (result facet created)
 */
export interface ScriptCompletedEvent {
  topic: 'script:completed';
  scriptId: string;
  success: boolean;
}

/**
 * Emitted when a tool call is created by a script
 */
export interface ToolCallCreatedEvent {
  topic: 'tool-call:created';
  toolCallId: string;
  parentScriptId: string;
  toolName: string;
}

/**
 * Emitted when a tool call completes (result facet created)
 */
export interface ToolCallCompletedEvent {
  topic: 'tool-call:completed';
  toolCallId: string;
  parentScriptId: string;
  success: boolean;
}

/**
 * Generic action events (for non-script actions)
 */
export interface ActionCreatedEvent {
  topic: 'action:created';
  actionId: string;
  actionName: string;
  parentActionId: string | null;
}

export interface ActionCompletedEvent {
  topic: 'action:completed';
  actionId: string;
  parentActionId: string | null;
  success: boolean;
}

/**
 * Union of all scripting-related events
 */
export type ScriptingEvent =
  | ScriptCreatedEvent
  | ScriptCompletedEvent
  | ToolCallCreatedEvent
  | ToolCallCompletedEvent
  | ActionCreatedEvent
  | ActionCompletedEvent;

// ============================================
// TOOL REGISTRY
// ============================================

/**
 * Parameter definition for a scriptable tool
 */
export interface ToolParameter {
  /** Parameter name */
  name: string;

  /** Type hint (for documentation/validation) */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

  /** Human-readable description */
  description: string;

  /** Whether this parameter is required */
  required?: boolean;

  /** Default value if not provided */
  defaultValue?: unknown;
}

/**
 * Definition of a tool that can be called from scripts
 */
export interface ScriptableTool {
  /** Tool name (becomes Lua function name) */
  name: string;

  /** Human-readable description */
  description: string;

  /** Parameter definitions */
  parameters: ToolParameter[];

  /**
   * Component type that handles this tool.
   * Used for routing tool calls to the correct handler.
   */
  handlerComponentType?: string;

  /**
   * Default invocation mode for this tool.
   * - 'native': Execute immediately, each call can trigger agent re-activation
   * - 'programmatic': Better for batching in Lua scripts, only final result triggers re-activation
   * Default: 'native'
   */
  defaultInvocationMode?: ToolInvocationMode;

  /**
   * Whether participants can override this tool's mode at runtime via facets.
   * Default: true
   */
  allowModeOverride?: boolean;
}

/**
 * Registry for tools available to scripts
 */
export interface IToolRegistry {
  /** Register a new tool */
  register(tool: ScriptableTool): void;

  /** Unregister a tool by name */
  unregister(name: string): void;

  /** Get all registered tools */
  getTools(): ScriptableTool[];

  /** Get a specific tool by name */
  getTool(name: string): ScriptableTool | undefined;

  /** Check if a tool is registered */
  hasTool(name: string): boolean;
}

// ============================================
// SCRIPT EXECUTOR CONFIGURATION
// ============================================

/**
 * Configuration for script execution
 */
export interface ScriptExecutionConfig {
  /** Default timeout in ms (default: 30000) */
  defaultTimeoutMs?: number;

  /** Maximum allowed timeout in ms (0 = unlimited) */
  maxTimeoutMs?: number;

  /** Whether to allow scripts with no timeout */
  allowNoTimeout?: boolean;
}

/**
 * Internal state for a pending script (used by executor)
 */
export interface PendingScript {
  /** Script facet ID */
  scriptId: string;

  /** Lua state handle */
  luaState: unknown; // fengari.lua_State

  /** Coroutine handle */
  coroutine: unknown; // fengari.lua_State (coroutine thread)

  /** Tool call we're currently waiting for */
  pendingToolCallId?: string;

  /** Timeout timer handle */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

// ============================================
// TYPE GUARDS
// ============================================

export function isScriptExecutionFacet(facet: BaseFacet): facet is ScriptExecutionFacet {
  return facet.type === 'script-execution';
}

export function isScriptResultFacet(facet: BaseFacet): facet is ScriptResultFacet {
  return facet.type === 'script-result';
}

export function isToolCallFacet(facet: BaseFacet): facet is ToolCallFacet {
  return facet.type === 'tool-call';
}

export function isToolCallResultFacet(facet: BaseFacet): facet is ToolCallResultFacet {
  return facet.type === 'tool-call-result';
}

export function isActionRequestFacet(facet: BaseFacet): facet is ActionRequestFacet {
  return facet.type === 'action-request';
}

export function isActionResultFacet(facet: BaseFacet): facet is ActionResultFacet {
  return facet.type === 'action-result';
}

export function isToolModePreferenceFacet(facet: BaseFacet): facet is ToolModePreferenceFacet {
  return facet.type === 'tool-mode-preference';
}

/**
 * Check if a status represents a terminal state (no more changes expected)
 */
export function isTerminalStatus(status: ActionStatus): boolean {
  return status === 'completed' || status === 'error';
}

/**
 * Check if a status represents an active state (still processing)
 */
export function isActiveStatus(status: ActionStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'blocked';
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create a new ScriptExecutionFacet
 */
export function createScriptExecutionFacet(
  id: string,
  code: string,
  agentId: string,
  options: {
    parentScriptId?: string | null;
    timeoutMs?: number | null;
    agentName?: string;
    status?: ActionStatus;
  } = {}
): ScriptExecutionFacet {
  return {
    id,
    type: 'script-execution',
    code,
    agentId,
    agentName: options.agentName,
    parentScriptId: options.parentScriptId ?? null,
    timeoutMs: options.timeoutMs,
    status: options.status ?? 'pending',
  };
}

/**
 * Create a new ScriptResultFacet
 */
export function createScriptResultFacet(
  id: string,
  scriptId: string,
  outcome: { success: true; result?: unknown } | { success: false; error: string; errorType?: ScriptResultFacet['errorType'] }
): ScriptResultFacet {
  return {
    id,
    type: 'script-result',
    scriptId,
    ...outcome,
  };
}

/**
 * Create a new ToolCallFacet
 */
export function createToolCallFacet(
  id: string,
  parentScriptId: string,
  toolName: string,
  args: unknown[],
  status: ActionStatus = 'pending'
): ToolCallFacet {
  return {
    id,
    type: 'tool-call',
    parentScriptId,
    toolName,
    args,
    status,
  };
}

/**
 * Create a new ToolCallResultFacet
 */
export function createToolCallResultFacet(
  id: string,
  toolCallId: string,
  parentScriptId: string,
  outcome: { success: true; result?: unknown } | { success: false; error: string }
): ToolCallResultFacet {
  return {
    id,
    type: 'tool-call-result',
    toolCallId,
    parentScriptId,
    ...outcome,
  };
}

/**
 * Create a new ActionRequestFacet
 */
export function createActionRequestFacet(
  id: string,
  actionName: string,
  options: {
    params?: Record<string, unknown>;
    parentActionId?: string | null;
    targetHandler?: string;
    status?: ActionStatus;
  } = {}
): ActionRequestFacet {
  return {
    id,
    type: 'action-request',
    actionName,
    params: options.params,
    parentActionId: options.parentActionId ?? null,
    targetHandler: options.targetHandler,
    status: options.status ?? 'pending',
  };
}

/**
 * Create a new ActionResultFacet
 */
export function createActionResultFacet(
  id: string,
  actionId: string,
  parentActionId: string | null,
  outcome: { success: true; result?: unknown; message?: string } | { success: false; error: string; message?: string },
  streamId?: string,
  streamType?: string
): ActionResultFacet {
  const facet: ActionResultFacet = {
    id,
    type: 'action-result',
    actionId,
    parentActionId,
    ...outcome,
  };
  if (streamId) {
    facet.streamId = streamId;
  }
  if (streamType) {
    facet.streamType = streamType;
  }
  return facet;
}

/**
 * Create a new ToolModePreferenceFacet
 */
export function createToolModePreferenceFacet(
  id: string,
  toolName: string,
  preferredMode: ToolInvocationMode,
  setBy: string,
  options: {
    priority?: number;
    expiresAt?: number;
    targetAgentId?: string;
  } = {}
): ToolModePreferenceFacet {
  const facet: ToolModePreferenceFacet = {
    id,
    type: 'tool-mode-preference',
    toolName,
    preferredMode,
    setBy,
  };
  if (options.priority !== undefined) {
    facet.priority = options.priority;
  }
  if (options.expiresAt !== undefined) {
    facet.expiresAt = options.expiresAt;
  }
  if (options.targetAgentId !== undefined) {
    facet.targetAgentId = options.targetAgentId;
  }
  return facet;
}
