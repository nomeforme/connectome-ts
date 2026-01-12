/**
 * ToolModeHandler - Handles setToolMode actions from agents
 *
 * This component listens for 'setToolMode' action facets and creates
 * ToolModePreferenceFacet instances in VEIL state to change how tools
 * are invoked.
 *
 * Usage by agent:
 * ```xml
 * <action name="setToolMode">
 *   <parameter name="toolName">discord.send</parameter>
 *   <parameter name="mode">programmatic</parameter>
 * </action>
 * ```
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { hasStateAspect } from '../veil/types';
import {
  ToolInvocationMode,
  createToolModePreferenceFacet,
  createActionResultFacet,
  IToolRegistry,
} from './types';
import { getGlobalToolRegistry } from './tool-registry';

/**
 * Parameters for setToolMode action
 */
interface SetToolModeParams {
  /** Tool name or '*' for all tools */
  toolName: string;
  
  /** Target mode: 'native' or 'programmatic' */
  mode: ToolInvocationMode;
  
  /** Optional: priority for this preference (default: 75 for agent-set) */
  priority?: number;
  
  /** Optional: duration in milliseconds (creates expiring preference) */
  duration?: number;
  
  /** Optional: target specific agent ID */
  targetAgentId?: string;
}

/**
 * ToolModeHandler component
 *
 * Processes 'setToolMode' actions and creates corresponding preference facets.
 */
export class ToolModeHandler extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  private toolRegistry?: IToolRegistry;

  /**
   * Set the tool registry for validation
   */
  setToolRegistry(registry: IToolRegistry): void {
    this.toolRegistry = registry;
  }

  onMount(): void {
    if (!this.toolRegistry) {
      this.toolRegistry = this.getReference<IToolRegistry>('toolRegistry');
      if (!this.toolRegistry) {
        this.toolRegistry = getGlobalToolRegistry();
      }
    }
  }

  /**
   * FLEX execute - process setToolMode actions
   */
  execute(context: ExecutionContext): void {
    const { frame } = context;
    if (!frame?.deltas) return;

    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'action') {
        this.handleActionFacet(delta.facet);
      }
    }
  }

  private handleActionFacet(facet: any): void {
    if (!hasStateAspect(facet)) return;

    const actionState = facet.state as { toolName: string; parameters?: Record<string, any>; alias?: string };
    if (actionState.toolName !== 'setToolMode') return;

    const params = (actionState.parameters || {}) as SetToolModeParams;
    const agentId = facet.agentId || 'unknown';
    const agentName = facet.agentName;
    const streamId = facet.streamId;
    const streamType = facet.streamType;
    const alias = actionState.alias;

    // Validate parameters
    if (!params.toolName) {
      this.emitError(facet.id, 'Missing required parameter: toolName', streamId, streamType, alias);
      return;
    }

    if (!params.mode || !['native', 'programmatic'].includes(params.mode)) {
      this.emitError(
        facet.id,
        `Invalid mode: ${params.mode}. Must be 'native' or 'programmatic'`,
        streamId,
        streamType,
        alias
      );
      return;
    }

    // Check if tool exists (unless wildcard)
    if (params.toolName !== '*') {
      const tool = this.toolRegistry?.getTool(params.toolName);
      if (!tool) {
        // Warn but don't fail - tool might be registered later
        console.warn(`[ToolModeHandler] Tool '${params.toolName}' not found in registry (proceeding anyway)`);
      } else if (tool.allowModeOverride === false) {
        this.emitError(
          facet.id,
          `Tool '${params.toolName}' does not allow mode override`,
          streamId,
          streamType,
          alias
        );
        return;
      }
    }

    // Calculate expiration if duration specified
    let expiresAt: number | undefined;
    if (params.duration && params.duration > 0) {
      expiresAt = Date.now() + params.duration;
    }

    // Create the preference facet
    const preferenceId = `tool-mode:${params.toolName}:${Date.now()}`;
    const preferenceFacet = createToolModePreferenceFacet(
      preferenceId,
      params.toolName,
      params.mode,
      agentId,
      {
        priority: params.priority ?? 75, // Agent-set defaults to 75
        expiresAt,
        targetAgentId: params.targetAgentId,
      }
    );

    this.addOperation({ type: 'addFacet', facet: preferenceFacet });

    // Emit success result
    const resultId = `action-result:${facet.id}`;
    const resultFacet = createActionResultFacet(
      resultId,
      facet.id,
      null, // parentActionId
      {
        success: true,
        result: {
          toolName: params.toolName,
          mode: params.mode,
          preferenceId,
          expiresAt,
        },
        message: `Tool '${params.toolName}' mode set to '${params.mode}'`,
      },
      streamId,
      streamType,
      alias
    );
    this.addOperation({ type: 'addFacet', facet: resultFacet });

    // Emit event for observers
    this.emit({
      topic: 'tool-mode:changed',
      timestamp: Date.now(),
      payload: {
        toolName: params.toolName,
        mode: params.mode,
        setBy: agentId,
        preferenceId,
      },
    });

    console.log(`[ToolModeHandler] Set '${params.toolName}' mode to '${params.mode}' (by ${agentName || agentId})`);
  }

  private emitError(
    actionId: string,
    error: string,
    streamId?: string,
    streamType?: string,
    alias?: string
  ): void {
    const resultId = `action-result:${actionId}`;
    const resultFacet = createActionResultFacet(
      resultId,
      actionId,
      null,
      {
        success: false,
        error,
        message: 'Failed to set tool mode',
      },
      streamId,
      streamType,
      alias
    );
    this.addOperation({ type: 'addFacet', facet: resultFacet });
  }
}

/**
 * Create a new ToolModeHandler instance
 */
export function createToolModeHandler(): ToolModeHandler {
  return new ToolModeHandler();
}

// ============================================
// TOOL DEFINITION FOR HUD
// ============================================

/**
 * Tool definition for setToolMode action.
 * Register this with the agent's tools to enable mode switching.
 */
export const setToolModeToolDefinition = {
  name: 'setToolMode',
  description: 'Change the invocation mode for a tool. Use "native" for immediate execution with feedback, or "programmatic" for batched execution in Lua scripts.',
  parameters: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: 'Name of the tool to configure, or "*" for all tools',
      },
      mode: {
        type: 'string',
        enum: ['native', 'programmatic'],
        description: 'Invocation mode: "native" (immediate, each call triggers re-activation) or "programmatic" (batched, only final result triggers re-activation)',
      },
      priority: {
        type: 'number',
        description: 'Priority for this preference (higher wins in conflicts). Default: 75',
      },
      duration: {
        type: 'number',
        description: 'Optional duration in milliseconds. If set, preference expires after this time.',
      },
    },
    required: ['toolName', 'mode'],
  },
  defaultInvocationMode: 'native' as const, // This tool should always be native
  allowModeOverride: false, // Cannot change mode of setToolMode itself
};
