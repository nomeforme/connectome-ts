/**
 * ActivationCompletedReceptor - Transforms activation:completed events into VEIL facets
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 *
 * When an agent activation cycle completes (LLM call finishes), this receptor
 * receives the semantic event and creates all response facets (speech, action,
 * thought, etc.) in a single frame.
 *
 * This replaces the previous pattern where AgentComponent emitted multiple
 * veil:operation events (one per facet), which caused multiple frames.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { Facet } from '../veil/types';

/**
 * Payload for activation:completed event
 */
export interface ActivationCompletedPayload {
  /** The activation ID that completed */
  activationId: string;
  /** Agent ID that produced this response */
  agentId: string;
  /** Stream ID for multi-stream support */
  streamId?: string;
  /** Stream type (e.g., 'discord', 'console') */
  streamType?: string;
  /** The facets produced by the agent (speech, action, thought, etc.) */
  facets: Facet[];
  /** Raw agent output text (unfiltered, for debugging/logging) */
  rawOutput?: string;
  /** Any events the agent wants to emit */
  events?: Array<{ topic: string; payload?: any }>;
  /** Whether the activation succeeded */
  success: boolean;
  /** Error message if activation failed */
  error?: string;
}

export class ActivationCompletedReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['activation:completed'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'activation:completed') return;

    const payload = event.payload as ActivationCompletedPayload;
    if (!payload) {
      console.warn('[ActivationCompletedReceptor] Received activation:completed with no payload');
      return;
    }

    const { activationId, agentId, facets, events, success, error } = payload;

    if (!success) {
      console.error(`[ActivationCompletedReceptor] Activation ${activationId} failed: ${error}`);
      // Create an error event facet
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `activation-error-${activationId}-${Date.now()}`,
          type: 'event',
          content: error || 'Unknown error',
          state: {
            source: agentId,
            eventType: 'activation-error',
            metadata: { activationId, error }
          },
          streamId: payload.streamId || 'default',
          ephemeral: true
        }
      });
      return;
    }

    console.log(`[ActivationCompletedReceptor] Processing ${facets.length} facets from activation ${activationId}`);

    // Add all facets in this single frame
    for (const facet of facets) {
      this.addOperation({
        type: 'addFacet',
        facet
      });
    }

    // Queue any events the agent wants to emit
    // These will be processed in subsequent frames
    if (events && events.length > 0) {
      for (const evt of events) {
        this.emit({
          topic: evt.topic,
          payload: evt.payload,
          timestamp: Date.now()
        });
      }
    }
  }
}
