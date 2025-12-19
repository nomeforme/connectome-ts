/**
 * ActivationDecider - Decides when to activate the agent based on semantic events
 *
 * Runs at priority 200 to process semantic events and decide whether they
 * warrant agent activation. This centralizes all activation policy in one place.
 *
 * Listens to semantic events:
 * - action:completed - An action finished successfully
 * - action:failed - An action encountered an error
 * - panel:toggled - A control panel was opened or closed (agent should continue)
 * - debug:request-activation - Manual activation request from debug UI
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

interface PanelToggledPayload {
  panelId: string;
  state: 'opened' | 'closed';
}

export class ActivationDecider extends Component {
  // Must run before ContextTransform which renders context for activation facets
  constraints = [
    priorityConstraint(ComponentPriority.TRANSFORM),
    beforeComponentType('ContextTransform')
  ];

  // Subscribe to all activation-worthy events
  topics = ['action:completed', 'action:failed', 'panel:toggled', 'debug:request-activation'];

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
      case 'panel:toggled':
        this.handlePanelToggled(event);
        break;
      case 'debug:request-activation':
        this.handleDebugRequestActivation(event);
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

  private handlePanelToggled(event: any): void {
    const payload = event.payload as PanelToggledPayload;
    if (!payload) return;

    const reason = payload.state === 'opened'
      ? 'Panel opened - new tools available'
      : 'Panel closed';

    console.log(`[ActivationDecider] Creating activation for panel:toggled (${payload.state}) - ${reason}`);

    const activation = createAgentActivation(reason, {
      id: `activation-panel-${payload.panelId}-${Date.now()}`,
      priority: 'normal',
      source: 'panel-toggled',
      metadata: {
        trigger: 'control-panel-toggle',
        panelId: payload.panelId,
        panelState: payload.state
      }
    });

    this.addOperation({
      type: 'addFacet',
      facet: activation
    });
  }

  private handleDebugRequestActivation(event: any): void {
    const payload = event.payload as {
      reason?: string;
      priority?: 'low' | 'normal' | 'high';
      targetAgentId?: string;
      targetAgent?: string;
      streamId?: string;
    };

    const reason = payload?.reason || 'Manual activation from Debug UI';

    console.log(`[ActivationDecider] Creating activation for debug:request-activation - ${reason}`);

    const activation = createAgentActivation(reason, {
      id: `activation-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      priority: payload?.priority || 'high',
      source: 'debug-ui',
      streamId: payload?.streamId || 'console:debug-ui',
      targetAgentId: payload?.targetAgentId,
      targetAgent: payload?.targetAgent,
      metadata: {
        trigger: 'debug-ui-manual'
      }
    });

    this.addOperation({
      type: 'addFacet',
      facet: activation
    });
  }
}
