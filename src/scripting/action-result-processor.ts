/**
 * ActionResultProcessor - FLEX Maintainer that emits activation:create events from action-results
 *
 * Runs at MAINTAINER priority (400) to ensure it sees all action-results added
 * by Effectors (priority 300) in the current frame. Batches multiple results
 * into a single activation event to avoid overwhelming the agent.
 *
 * NOTE: This component emits semantic `activation:create` events instead of
 * `veil:operation` events. The ActivationReceptor handles these events and
 * creates the actual agent-activation facets. This follows the proper FLEX
 * pattern: events trigger frames → receptors create facets.
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

    // Batch results into a single activation
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    // Determine activation reason
    let reason: string;
    if (results.length === 1) {
      const r = results[0];
      reason = r.success ? 'Action completed' : `Action failed: ${r.error}`;
    } else {
      reason = `${results.length} actions completed (${successCount} succeeded, ${failCount} failed)`;
    }

    // Use streamId from the first result that has one (they should all be from same stream)
    const streamId = results.find(r => r.streamId)?.streamId;

    // Build metadata with all results
    const resultSummaries = results.map(r => ({
      actionId: r.actionId,
      success: r.success,
      result: r.result,
      error: r.error,
      message: r.message
    }));

    console.log(`[ActionResultProcessor] Emitting activation:create for ${results.length} action result(s), streamId: ${streamId}`);

    // Emit semantic activation:create event (triggers new frame, ActivationReceptor creates facet)
    this.emit({
      topic: 'activation:create',
      timestamp: Date.now(),
      payload: {
        reason,
        id: `activation-results-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        priority: 'normal',
        source: 'action-result',
        streamId,
        metadata: {
          resultCount: results.length,
          successCount,
          failCount,
          results: resultSummaries,
          reason: successCount === results.length ? 'actions_completed' : 'actions_mixed'
        }
      }
    });
  }
}
