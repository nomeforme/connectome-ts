import type { LLMMessage, LLMOptions, LLMProvider, LLMResponse, LLMStreamChunk } from './llm-interface';
import { debugLLMBridge } from './debug-llm-bridge';
import { getGlobalTracer, TraceCategory } from '../tracing';

export interface DebugLLMProviderConfig {
  providerId?: string;
  description?: string;
}

export class DebugLLMProvider implements LLMProvider {
  private readonly providerId: string;
  private readonly description?: string;

  constructor(config: DebugLLMProviderConfig = {}) {
    this.providerId = config.providerId || 'debug';
    this.description = config.description;
    debugLLMBridge.registerProvider(this.providerId);
  }

  async generate(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const filteredMessages = messages.filter(message => message.role !== 'cache');
    const tracer = getGlobalTracer();

    tracer?.record({
      id: `debug-llm-request-${Date.now()}`,
      timestamp: Date.now(),
      level: 'debug',
      category: TraceCategory.LLM_REQUEST,
      component: 'DebugLLMProvider',
      operation: 'generate',
      data: {
        providerId: this.providerId,
        messageCount: filteredMessages.length,
        lastRole: filteredMessages[filteredMessages.length - 1]?.role,
        lastPreview: filteredMessages[filteredMessages.length - 1]?.content.substring(0, 160),
        options
      }
    });

    const { completion } = debugLLMBridge.createRequest({
      providerId: this.providerId,
      messages: filteredMessages,
      options,
      metadata: {
        description: this.description
      }
    });

    const response = await completion;
    const finalized: LLMResponse = {
      ...response,
      tokensUsed: response.tokensUsed ?? this.estimateTokens(response.content),
      modelId: response.modelId ?? options?.modelId
    };

    tracer?.record({
      id: `debug-llm-response-${Date.now()}`,
      timestamp: Date.now(),
      level: 'debug',
      category: TraceCategory.LLM_RESPONSE,
      component: 'DebugLLMProvider',
      operation: 'generate',
      data: {
        providerId: this.providerId,
        contentLength: finalized.content.length,
        tokensUsed: finalized.tokensUsed,
        modelId: finalized.modelId
      }
    });

    return finalized;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return this.providerId;
  }

  getCapabilities() {
    return {
      supportsPrefill: true,
      supportsCaching: false,
      supportsStreaming: false, // Debug provider waits for manual input, streaming doesn't apply
      maxContextLength: 100000
    };
  }

  /**
   * Streaming fallback - Debug provider doesn't support true streaming
   * since responses are entered manually. Falls back to non-streaming.
   */
  async *generateStream(
    messages: LLMMessage[],
    options?: LLMOptions
  ): AsyncIterable<LLMStreamChunk> {
    // Get the full response (waits for manual debug input)
    const response = await this.generate(messages, options);

    // Yield the entire response as one chunk
    yield {
      content: response.content,
      done: false
    };

    // Emit final chunk
    yield {
      content: '',
      done: true,
      tokensUsed: response.tokensUsed,
      modelId: response.modelId
    };
  }
}
