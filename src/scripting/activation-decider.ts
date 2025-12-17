/**
 * ActivationDecider - Decides when to activate the agent based on semantic events
 *
 * Runs at priority 200 to process semantic events and decide whether they
 * warrant agent activation. This centralizes all activation policy in one place.
 *
 * Listens to semantic events:
 * - action:completed - An action finished successfully
 * - action:failed - An action encountered an error
 * - panel:closed - A control panel was closed (agent should continue)
 *
 * FLEX pattern:
 * - Events describe what happened (semantic)
 * - ActivationDecider decides whether to activate (policy)
 * - Creates agent-activation facets directly
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority, beforeComponentType } from '../spaces/constraints';
import { createAgentActivation } from '../helpers/factories';

interface ActionCompletedPayload {
  resultCount: number;
  successCount: number;
  failCount: number;
  streamId?: string;
  streamType?: string;
  results: Array<{
    actionId: string;
    success: boolean;
    result?: unknown;
    error?: string;
    message?: string;
  }>;
}

interface PanelClosedPayload {
  panelId: string;
  streamId?: string;
}

export class ActivationDecider extends Component {
  // Must run before ContextTransform which renders context for activation facets
  constraints = [
    priorityConstraint(ComponentPriority.TRANSFORM),
    beforeComponentType('ContextTransform')
  ];

  // Subscribe to all activation-worthy events
  topics = ['action:completed', 'action:failed', 'panel:closed'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event) return;

    switch (event.topic) {
      case 'action:completed':
        this.handleActionCompleted(event);
        break;
      case 'action:failed':
        this.handleActionFailed(event);
        break;
      case 'panel:closed':
        this.handlePanelClosed(event);
        break;
    }
  }

  private handleActionCompleted(event: any): void {
    const payload = event.payload as ActionCompletedPayload;
    if (!payload) return;

    const { resultCount, successCount, failCount, streamId, streamType, results } = payload;

    // Determine activation reason
    let reason: string;
    if (resultCount === 1) {
      const r = results[0];
      reason = r.success ? 'Action completed' : `Action failed: ${r.error}`;
    } else {
      reason = `${resultCount} actions completed (${successCount} succeeded, ${failCount} failed)`;
    }

    console.log(`[ActivationDecider] Creating activation for action:completed - ${reason}, streamId: ${streamId}, streamType: ${streamType}`);

    const activation = createAgentActivation(reason, {
      id: `activation-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      priority: 'normal',
      source: 'action-completed',
      streamId,
      streamType,
      metadata: {
        resultCount,
        successCount,
        failCount,
        results
      }
    });

    this.addOperation({
      type: 'addFacet',
      facet: activation
    });
  }

  private handleActionFailed(event: any): void {
    const payload = event.payload as {
      error: string;
      actionId?: string;
      streamId?: string;
    };
    if (!payload) return;

    const reason = `Action failed: ${payload.error}`;

    console.log(`[ActivationDecider] Creating activation for action:failed - ${reason}`);

    const activation = createAgentActivation(reason, {
      id: `activation-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      priority: 'high', // Errors get higher priority
      source: 'action-failed',
      streamId: payload.streamId,
      metadata: {
        error: payload.error,
        actionId: payload.actionId
      }
    });

    this.addOperation({
      type: 'addFacet',
      facet: activation
    });
  }

  private handlePanelClosed(event: any): void {
    const payload = event.payload as PanelClosedPayload;
    if (!payload) return;

    const reason = 'Panel closed';

    console.log(`[ActivationDecider] Creating activation for panel:closed - ${reason}`);

    const activation = createAgentActivation(reason, {
      id: `activation-panel-${payload.panelId}-${Date.now()}`,
      priority: 'normal',
      source: 'panel-closed',
      streamId: payload.streamId,
      metadata: {
        trigger: 'control-panel-toggle',
        panelId: payload.panelId
      }
    });

    this.addOperation({
      type: 'addFacet',
      facet: activation
    });
  }
}
