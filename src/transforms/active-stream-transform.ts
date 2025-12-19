/**
 * ActiveStreamTransform
 *
 * FLEX Component (constraint: priority 50) that sets frame.activeStream based on events.
 * Generic transform that works for any adapter (Discord, Slack, file editor, etc.)
 *
 * Uses the LAST event with streamId (most recent activity)
 * This ensures currentStream reflects the most recent stream interaction.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint } from '../spaces/constraints';

export class ActiveStreamTransform extends Component {
  // Early in execution, before rendering (ContextTransform is 200)
  constraints = [priorityConstraint(50)];

  execute(context: ExecutionContext): void {
    const { frame } = context;

    if (!frame) return;

    // Skip if activeStream already set
    if ((frame as any).activeStream) return;

    // Find LAST event with streamId (most recent activity)
    for (let i = frame.events.length - 1; i >= 0; i--) {
      const event = frame.events[i];
      const payload = event.payload as any;

      if (payload?.streamId) {
        // Set frame's activeStream from this event
        (frame as any).activeStream = {
          streamId: payload.streamId,
          streamType: payload.streamType || 'unknown',
          metadata: {
            ...(payload.metadata || {}),
            eventTopic: event.topic
          }
        };

        console.log(`[ActiveStreamTransform] Set frame ${frame.sequence} activeStream to ${payload.streamId} (from event ${i}/${frame.events.length})`);
        break;
      }
    }
  }
}
