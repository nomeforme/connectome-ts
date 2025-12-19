/**
 * ResponseHandler - Accumulates streaming chunks and emits activation:completed
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 *
 * This component listens to activation:stream events and accumulates the chunks.
 * When a stream completes (done=true), it emits activation:completed with the
 * full accumulated response, which is then parsed by ActivationCompletedReceptor
 * in a new full-weight frame.
 *
 * Future: This component will be extended to detect tool call tokens mid-stream
 * and trigger early interruption for synchronous tool execution.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { ActivationCompletedPayload } from './activation-completed-receptor';

/**
 * Payload for activation:stream event
 *
 * Design note: This payload contains only the incremental chunk, not accumulated
 * content. This avoids O(n²) memory usage across streaming events. ResponseHandler
 * tracks accumulation internally, and debug UI reconstructs accumulated content
 * from frame history on demand.
 */
export interface ActivationStreamPayload {
  /** The activation ID being streamed */
  activationId: string;
  /** Agent ID producing this stream */
  agentId: string;
  /** Agent name (for facet attribution) */
  agentName?: string;
  /** Stream ID for multi-stream support */
  streamId?: string;
  /** Stream type (e.g., 'discord', 'console') */
  streamType?: string;
  /** Incremental content chunk */
  chunk: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Sequence number for ordering */
  streamSequence: number;
  /** Token count (only on final chunk) */
  tokensUsed?: number;
  /** Model ID (only on final chunk) */
  modelId?: string;
  /** Registered tools (passed through to activation:completed) */
  tools?: Map<string, any>;
}

/**
 * Internal state for tracking a stream
 */
interface StreamState {
  accumulated: string;
  agentId: string;
  agentName?: string;
  streamId?: string;
  streamType?: string;
  tools?: Map<string, any>;
  lastSequence: number;
}

export class ResponseHandler extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['activation:stream'];

  private streams = new Map<string, StreamState>();

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'activation:stream') return;

    const payload = event.payload as ActivationStreamPayload;
    if (!payload) {
      console.warn('[ResponseHandler] Received activation:stream with no payload');
      return;
    }

    const {
      activationId,
      agentId,
      agentName,
      streamId,
      streamType,
      chunk,
      done,
      streamSequence,
      tokensUsed,
      modelId,
      tools
    } = payload;

    // Get existing stream state or create new one
    let streamState = this.streams.get(activationId);
    if (!streamState) {
      streamState = {
        accumulated: '',
        agentId,
        agentName,
        streamId,
        streamType,
        tools,
        lastSequence: -1
      };
      this.streams.set(activationId, streamState);
    }

    // Accumulate chunks internally (this is the canonical accumulation)
    // Note: We track this here instead of in the payload to avoid O(n²) memory
    streamState.accumulated += chunk;
    streamState.lastSequence = streamSequence;

    // Update metadata that might change (tools could be updated)
    if (tools) streamState.tools = tools;

    // Future: Scan accumulated content for tool call tokens here
    // If detected, could emit an interruption event

    if (done) {
      const streamState = this.streams.get(activationId);
      if (!streamState) {
        console.warn(`[ResponseHandler] Stream completed but no state found for ${activationId}`);
        return;
      }

      console.log(`[ResponseHandler] Stream ${activationId} completed (${streamState.accumulated.length} chars)`);

      // Emit activation:completed for parsing in next frame
      const completedPayload: ActivationCompletedPayload = {
        activationId,
        agentId: streamState.agentId,
        agentName: streamState.agentName,
        streamId: streamState.streamId,
        streamType: streamState.streamType,
        rawOutput: streamState.accumulated,
        llmMetadata: {
          tokensUsed,
          model: modelId,
          timestamp: new Date().toISOString()
        },
        tools: streamState.tools,
        success: true
      };

      this.emit({
        topic: 'activation:completed',
        timestamp: Date.now(),
        payload: completedPayload
      });

      // Clean up
      this.streams.delete(activationId);
    }
  }

  /**
   * Get current stream state (for debugging/testing)
   */
  getStreamState(activationId: string): StreamState | undefined {
    return this.streams.get(activationId);
  }

  /**
   * Get all active streams (for debugging)
   */
  getActiveStreams(): Map<string, StreamState> {
    return new Map(this.streams);
  }
}
