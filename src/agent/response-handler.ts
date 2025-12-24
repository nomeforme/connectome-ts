/**
 * ResponseHandler - Accumulates streaming chunks and emits activation:completed
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 *
 * This component listens to activation:stream events and accumulates the chunks.
 * When a stream completes (done=true), it emits activation:completed with the
 * full accumulated response, which is then parsed by ActivationCompletedHandler
 * in a new full-weight frame.
 *
 * Sync Tool Mode: When toolMode='sync' (default), this component detects tool
 * calls mid-stream and emits early activation:completed to interrupt the stream
 * and execute tools synchronously. The agent continues with a new activation
 * that includes the partial response and tool results.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { ActivationCompletedPayload } from './activation-completed-receptor';
import { detectToolCall, DetectedToolCall } from './incremental-tool-detector';
import { StreamAbortRegistry } from './stream-abort-registry';

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
  /** Whether we've already emitted an interrupted completion for this stream */
  interruptedEmitted: boolean;
  /** Last scan position to avoid rescanning entire content */
  lastScanPosition: number;
}

/**
 * Configuration for ResponseHandler
 */
export interface ResponseHandlerConfig {
  /** Tool execution mode: 'sync' (default) or 'async' */
  toolMode?: 'sync' | 'async';
}

export class ResponseHandler extends Component {
  constraints = [priorityConstraint(ComponentPriority.RECEPTOR)];
  topics = ['activation:stream'];

  private streams = new Map<string, StreamState>();
  private toolMode: 'sync' | 'async';

  constructor(config: ResponseHandlerConfig = {}) {
    super();
    this.toolMode = config.toolMode ?? 'sync';
  }

  /**
   * Set tool mode dynamically (for testing or runtime configuration)
   */
  setToolMode(mode: 'sync' | 'async'): void {
    this.toolMode = mode;
  }

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
        lastSequence: -1,
        interruptedEmitted: false,
        lastScanPosition: 0
      };
      this.streams.set(activationId, streamState);
    }

    // If we've already emitted an interrupted completion, ignore further chunks
    // (they'll arrive until the abort propagates)
    if (streamState.interruptedEmitted) {
      return;
    }

    // Accumulate chunks internally (this is the canonical accumulation)
    // Note: We track this here instead of in the payload to avoid O(n²) memory
    streamState.accumulated += chunk;
    streamState.lastSequence = streamSequence;

    // Update metadata that might change (tools could be updated)
    if (tools) streamState.tools = tools;

    // Sync tool mode: Scan for tool calls during streaming
    if (this.toolMode === 'sync' && !done) {
      const detection = detectToolCall(streamState.accumulated, this.toolMode);

      if (detection.found && detection.toolCall) {
        console.log(`[ResponseHandler] Tool call detected mid-stream: ${detection.toolCall.toolName}`);

        // Mark as interrupted to ignore further chunks
        streamState.interruptedEmitted = true;

        // Signal the streaming agent to abort
        StreamAbortRegistry.abort(activationId, `Tool call detected: ${detection.toolCall.toolName}`);

        // Emit early activation:completed with interruption info
        const completedPayload: ActivationCompletedPayload = {
          activationId,
          agentId: streamState.agentId,
          agentName: streamState.agentName,
          streamId: streamState.streamId,
          streamType: streamState.streamType,
          rawOutput: streamState.accumulated,
          llmMetadata: {
            tokensUsed: undefined, // Not available yet
            model: modelId,
            timestamp: new Date().toISOString()
          },
          tools: streamState.tools,
          success: true,
          // New fields for sync tool mode
          interrupted: true,
          partialContent: detection.contentBefore,
          detectedToolCall: detection.toolCall
        };

        this.emit({
          topic: 'activation:completed',
          timestamp: Date.now(),
          payload: completedPayload
        });

        // Note: Stream cleanup happens when abort completes (done=true arrives)
        // or via explicit cleanup. Don't delete here - we need to track state
        // to ignore remaining chunks.
        return;
      }
    }

    if (done) {
      const streamState = this.streams.get(activationId);
      if (!streamState) {
        console.warn(`[ResponseHandler] Stream completed but no state found for ${activationId}`);
        return;
      }

      // If we already emitted an interrupted completion, just clean up
      if (streamState.interruptedEmitted) {
        console.log(`[ResponseHandler] Stream ${activationId} done after interrupt, cleaning up`);
        this.streams.delete(activationId);
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
