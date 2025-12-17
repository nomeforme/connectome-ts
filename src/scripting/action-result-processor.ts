/**
 * ActionResultProcessor - FLEX Maintainer that emits action:completed events from action-results
 *
 * Runs at MAINTAINER priority (400) to ensure it sees all action-results added
 * by Effectors (priority 300) in the current frame. Batches multiple results
 * into a single event.
 *
 * NOTE: This component emits semantic `action:completed` events - describing
 * what happened, not what to do about it. The ActivationDeciderTransform
 * (priority 200, runs next frame) decides whether to activate the agent.
 *
 * FLEX pattern: Events are semantic (what happened), Transforms decide policy.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { FacetFilter } from '../spaces/receptor-effector-types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { ActionResultFacet } from './types';

export class ActionResultProcessor extends Component {
  constraints = [priorityConstraint(ComponentPriority.MAINTAINER)];

  facetFilters: FacetFilter[] = [
    { type: 'action-result' }
  ];

  private processedResults = new Set<string>();

  execute(context: ExecutionContext): void {
    const { frame } = context;
    if (!frame?.deltas) return;

    // Collect all action-results from this frame
    const results: ActionResultFacet[] = [];

    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'action-result') {
        const resultId = delta.facet.id;
        if (this.processedResults.has(resultId)) continue;
        this.processedResults.add(resultId);
        results.push(delta.facet as ActionResultFacet);
      }
    }

    if (results.length === 0) return;

    // Batch results
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    // Use streamId/streamType from the first result that has one (they should all be from same stream)
    const streamId = results.find(r => r.streamId)?.streamId;
    const streamType = results.find(r => r.streamType)?.streamType;

    // Build result summaries
    const resultSummaries = results.map(r => ({
      actionId: r.actionId,
      success: r.success,
      result: r.result,
      error: r.error,
      message: r.message
    }));

    console.log(`[ActionResultProcessor] Emitting action:completed for ${results.length} result(s), streamId: ${streamId}, streamType: ${streamType}`);

    // Emit semantic action:completed event (ActivationDeciderTransform decides whether to activate)
    this.emit({
      topic: 'action:completed',
      timestamp: Date.now(),
      payload: {
        resultCount: results.length,
        successCount,
        failCount,
        streamId,
        streamType,
        results: resultSummaries
      }
    });
  }
}
