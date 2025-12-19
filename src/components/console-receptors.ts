/**
 * Console Receptors and Effectors - FLEX Architecture
 *
 * FLEX Components for console input/output handling.
 */

import { Component } from '../spaces/component';
import { ExecutionContext, SpaceEvent } from '../spaces/types';
import {
  ReadonlyVEILState,
  FacetDelta,
  FacetFilter
} from '../spaces/receptor-effector-types';
import { hasContentAspect, VEILDelta } from '../veil/types';
import { createAgentActivation, createEventFacet, wrapFacetsAsDeltas } from '../helpers/factories';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';

/**
 * Converts console input events into message AND activation facets
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 */
export class ConsoleInputReceptor extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['console:input'];

  execute(context: ExecutionContext): void {
    const { event, state } = context;
    if (!event || event.topic !== 'console:input') return;

    const payload = event.payload as { input: string; timestamp?: number };
    const timestamp = payload.timestamp || Date.now();
    const messageId = `console-msg-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;

    const messageFacet = createEventFacet({
      id: messageId,
      content: payload.input,
      source: 'console',
      eventType: 'console-message',
      metadata: { timestamp },
      streamId: 'console',
      streamType: 'console'
    });

    const activationFacet = createAgentActivation('Console input received', {
      id: `activation-${messageId}`,
      priority: 'normal',
      sourceAgentId: 'user',
      sourceAgentName: 'User',
      streamRef: {
        streamId: 'console',
        streamType: 'console'
      }
    });

    for (const delta of wrapFacetsAsDeltas([messageFacet, activationFacet])) {
      this.addOperation(delta);
    }
  }
}

/**
 * Watches for speech facets and outputs to console
 *
 * FLEX Component (constraint: priority 300 - Effector level)
 */
export class ConsoleOutputEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  facetFilters: FacetFilter[] = [{
    type: 'speech'
  }];

  constructor(
    private write: (content: string) => void = console.log
  ) {
    super();
  }

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    // Build changes from frame deltas
    const changes: FacetDelta[] = [];
    if (frame.deltas) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet' && delta.facet.type === 'speech') {
          changes.push({ type: 'added', facet: delta.facet });
        }
      }
    }

    if (changes.length === 0) return;

    // Process speech facets
    for (const change of changes) {
      if (change.type === 'added' && hasContentAspect(change.facet)) {
        // Output to console
        this.write(`\n${change.facet.content}\n`);
      }
    }
  }
}
