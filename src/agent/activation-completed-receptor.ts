/**
 * ActivationCompletedReceptor - Transforms activation:completed events into VEIL facets
 *
 * FLEX Component (constraint: priority 100 - Receptor level)
 *
 * When an agent activation cycle completes (LLM call finishes), this receptor
 * receives the raw LLM output and parses it into facets (speech, action,
 * thought, etc.) in a single frame.
 *
 * The raw output is carried through the event, making it visible for
 * debugging and enabling future streaming support (activation:stream).
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';
import { parseAgentResponse, ParserConfig } from './response-parser';
import { ToolDefinition } from './types';
import { DetectedToolCall } from './incremental-tool-detector';

/**
 * Payload for activation:completed event
 */
export interface ActivationCompletedPayload {
  /** The activation ID that completed */
  activationId: string;
  /** Agent ID that produced this response */
  agentId: string;
  /** Agent name (for facet attribution) */
  agentName?: string;
  /** Stream ID for multi-stream support */
  streamId?: string;
  /** Stream type (e.g., 'discord', 'console') */
  streamType?: string;
  /** Raw LLM output (unfiltered, the actual response text) */
  rawOutput: string;
  /** LLM metadata */
  llmMetadata?: {
    tokensUsed?: number;
    provider?: string;
    model?: string;
    timestamp?: string;
  };
  /** Registered tools (for event emission during parsing) */
  tools?: Map<string, ToolDefinition>;
  /** Whether the activation succeeded */
  success: boolean;
  /** Error message if activation failed */
  error?: string;

  // === Sync Tool Mode Fields ===

  /** True if a tool call was detected mid-stream and interrupted the activation */
  interrupted?: boolean;
  /** Content before the detected tool call (for continuation context) */
  partialContent?: string;
  /** The detected tool call that caused the interruption */
  detectedToolCall?: DetectedToolCall;
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

    const { activationId, agentId, agentName, streamId, rawOutput, tools, success, error } = payload;

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
          streamId: streamId || 'default',
          ephemeral: true
        }
      });
      return;
    }

    if (!rawOutput) {
      console.warn(`[ActivationCompletedReceptor] Activation ${activationId} completed but no rawOutput provided`);
      return;
    }

    console.log(`[ActivationCompletedReceptor] Parsing raw output for activation ${activationId} (${rawOutput.length} chars)`);

    // Parse the raw output into facets
    const parserConfig: ParserConfig = {
      agentId,
      agentName,
      defaultStreamId: streamId || 'default',
      tools
    };

    const parsed = parseAgentResponse(rawOutput, parserConfig);

    console.log(`[ActivationCompletedReceptor] Parsed ${parsed.operations.length} operations, ${parsed.events.length} events`);

    // Add all facets in this single frame
    for (const operation of parsed.operations) {
      this.addOperation(operation);
    }

    // Queue any events (for tool invocations)
    // These will be processed in subsequent frames
    if (parsed.events.length > 0) {
      for (const evt of parsed.events) {
        this.emit({
          topic: evt.topic,
          payload: evt.payload,
          timestamp: Date.now()
        });
      }
    }
  }
}
