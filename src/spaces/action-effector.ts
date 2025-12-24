/**
 * ActionRouter - Executes component handlers when action facets are created
 *
 * FLEX Component (constraint: priority 300) that watches for action facets created by agents
 * and routes them to the appropriate component handlers for execution.
 */

import { Component } from './component';
import { ExecutionContext, SpaceEvent } from './types';
import {
  FacetDelta,
  ReadonlyVEILState,
  FacetFilter
} from './component-types';
import { hasStateAspect } from '../veil/types';
import { priorityConstraint, ComponentPriority } from './constraints';
import { createActionResultFacet } from '../scripting/types';

/**
 * Context passed to action handlers, including stream attribution
 * from the originating action facet.
 */
export interface ActionContext {
  /** The action facet ID */
  actionId: string;
  /** Stream ID for response routing */
  streamId?: string;
  /** Stream type (e.g., 'discord', 'console') */
  streamType?: string;
  /** Agent that initiated this action */
  agentId?: string;
  /** Agent name */
  agentName?: string;
}

export class ActionRouter extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  // Watch for action facets
  facetFilters: FacetFilter[] = [
    { type: 'action' }
  ];

  /**
   * FLEX execute method - processes frame context for action facets
   */
  execute(context: ExecutionContext): void {
    const { state, frame } = context;

    // Build changes from frame deltas
    const changes: FacetDelta[] = [];
    if (frame && frame.deltas) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet' && delta.facet.type === 'action') {
          changes.push({ type: 'added', facet: delta.facet });
        }
      }
    }

    if (changes.length === 0) return;

    // Process actions (fire and forget)
    this.processActions(changes, state);
  }

  /**
   * Process action facets and execute handlers
   */
  private async processActions(changes: FacetDelta[], state: ReadonlyVEILState): Promise<void> {
    for (const change of changes) {
      if (change.type !== 'added') continue;

      const facet = change.facet;
      if (facet.type !== 'action') continue;
      if (!hasStateAspect(facet)) continue;

      const actionState = facet.state as { toolName: string; parameters?: Record<string, any> };
      const toolName = actionState.toolName;
      const parameters = actionState.parameters || {};

      // Extract stream context from facet for attribution
      const actionContext: ActionContext = {
        actionId: facet.id,
        streamId: (facet as any).streamId,
        streamType: (facet as any).streamType,
        agentId: (facet as any).agentId,
        agentName: (facet as any).agentName
      };

      // Skip actions handled by other effectors (e.g., ScriptRunner handles 'lua')
      const specialActions = ['lua'];
      if (specialActions.includes(toolName)) {
        continue;
      }

      console.log(`[ActionRouter] Processing action facet: ${toolName}`, parameters);

      // Parse tool name to extract target ID and action
      const parts = toolName.split('.');
      if (parts.length < 2) {
        console.warn(`[ActionRouter] Invalid tool name format: ${toolName} (expected "targetId.action")`);
        continue;
      }

      const targetId = parts[0];
      const action = parts[parts.length - 1];

      const space = this.space;
      if (!space) {
        console.warn(`[ActionRouter] No space found for action routing`);
        continue;
      }

      // Try direct lookup by component ID
      let component = space.getComponentById(targetId);

      // Try prefix match if direct lookup failed
      if (!component) {
        component = space.components.find((c: any) =>
          c.id === targetId ||
          (c.id && c.id.startsWith(`${targetId}:`))
        );
      }

      // If still not found, consult action-definition facets to resolve friendly names
      if (!component) {
        const actualComponentId = this.resolveComponentIdFromActionDefinition(toolName, state);
        if (actualComponentId) {
          component = space.getComponentById(actualComponentId);
          if (component) {
            console.log(`[ActionRouter] Resolved '${targetId}' to '${actualComponentId}' via action-definition`);
          }
        }
      }

      if (!component) {
        console.warn(`[ActionRouter] Target component not found: ${targetId}`);

        // Create action-result facet for component not found
        const alias = (facet as any).state?.alias;
        const actionResultFacet = createActionResultFacet(
          `action-result:${facet.id}`,
          facet.id,
          null,  // parentActionId
          { success: false, error: `Target component '${targetId}' not found`, message: `Component not found` },
          actionContext.streamId,
          actionContext.streamType,
          alias
        );
        this.addOperation({ type: 'addFacet', facet: actionResultFacet });
        continue;
      }

      console.log(`[ActionRouter] Found target component: ${component.constructor.name} (${component.id})`);

      // Execute action on component
      const comp = component as any;
      if (comp.actions && comp.actions.has && comp.actions.has(action)) {
        const handler = comp.actions.get(action);
        console.log(`[ActionRouter] Calling component action handler for '${action}' with context:`, actionContext);
        try {
          // Pass action context as second parameter for stream attribution
          const result = await handler(parameters, actionContext);
          console.log(`[ActionRouter] Successfully executed action via component handler`);

          // Create action-result facet for success
          const alias = (facet as any).state?.alias;
          const actionResultFacet = createActionResultFacet(
            `action-result:${facet.id}`,
            facet.id,
            null,  // parentActionId
            { success: true, result, message: `Action '${toolName}' completed` },
            actionContext.streamId,
            actionContext.streamType,
            alias
          );
          this.addOperation({ type: 'addFacet', facet: actionResultFacet });
        } catch (error) {
          console.error(`[ActionRouter] Error executing component action:`, error);

          // Create action-result facet for failure
          const alias = (facet as any).state?.alias;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const actionResultFacet = createActionResultFacet(
            `action-result:${facet.id}`,
            facet.id,
            null,  // parentActionId
            { success: false, error: errorMessage, message: `Action '${toolName}' failed` },
            actionContext.streamId,
            actionContext.streamType,
            alias
          );
          this.addOperation({ type: 'addFacet', facet: actionResultFacet });
        }
      } else {
        console.warn(`[ActionRouter] No handler found for action '${action}' on component '${targetId}'`);

        // Create action-result facet for handler not found
        const alias = (facet as any).state?.alias;
        const actionResultFacet = createActionResultFacet(
          `action-result:${facet.id}`,
          facet.id,
          null,  // parentActionId
          { success: false, error: `No handler found for action '${action}'`, message: `Action handler not found` },
          actionContext.streamId,
          actionContext.streamType,
          alias
        );
        this.addOperation({ type: 'addFacet', facet: actionResultFacet });
      }
    }
  }

  /**
   * Look up the actual component ID from action-definition facets
   * This allows friendly tool names (e.g., "discord-control.open") to route
   * to actual component IDs (e.g., "component:DiscordControlPanelComponent")
   */
  private resolveComponentIdFromActionDefinition(toolName: string, state: ReadonlyVEILState): string | null {
    for (const [, facet] of state.facets) {
      if (facet.type === 'action-definition') {
        const attrs = (facet as any).attributes;
        if (attrs && attrs.toolName === toolName && attrs.componentId) {
          return attrs.componentId;
        }
      }
    }
    return null;
  }
}
