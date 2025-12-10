/**
 * Vertex AI LLM Provider
 * 
 * Implements the LLMProvider interface for Google's Gemini models via Vertex AI.
 */

import { 
  LLMProvider, 
  LLMMessage, 
  LLMOptions, 
  LLMResponse 
} from './llm-interface';
import { getGlobalTracer, TraceCategory } from '../tracing';

export interface VertexProviderConfig {
  apiKey: string;
  projectId?: string;
  location?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

interface VertexMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export class VertexProvider implements LLMProvider {
  private apiKey: string;
  private projectId: string;
  private location: string;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: VertexProviderConfig) {
    this.apiKey = config.apiKey;
    this.projectId = config.projectId || 'default-project';
    this.location = config.location || 'us-central1';
    this.defaultModel = config.defaultModel || 'gemini-1.5-pro';
    this.defaultMaxTokens = config.defaultMaxTokens || 8192;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  async generate(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    // Filter out cache markers
    const apiMessages = messages.filter(m => m.role !== 'cache');
    
    // Extract system message if present
    const systemMessage = apiMessages.find(m => m.role === 'system');
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');
    
    // Convert to Vertex AI format
    const vertexMessages: VertexMessage[] = conversationMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // Build the request payload
    const model = options?.modelId || this.defaultModel;
    // Use the simplified Vertex AI endpoint with API key
    const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${this.apiKey}`;
    
    const requestBody: any = {
      contents: vertexMessages,
      generationConfig: {
        maxOutputTokens: options?.maxTokens || this.defaultMaxTokens,
        temperature: options?.temperature ?? 1.0,
      }
    };

    // Add system instruction if present
    if (systemMessage) {
      requestBody.systemInstruction = {
        parts: [{ text: systemMessage.content }]
      };
    }

    // Add stop sequences if present
    if (options?.stopSequences && options.stopSequences.length > 0) {
      requestBody.generationConfig.stopSequences = options.stopSequences;
    }

    // Log and trace the request
    console.log('[VertexProvider:generate] Starting request...');
    const tracer = getGlobalTracer();
    tracer?.record({
      id: `llm-request-${Date.now()}`,
      timestamp: Date.now(),
      level: 'info',
      category: TraceCategory.LLM_REQUEST,
      component: 'VertexProvider',
      operation: 'generate',
      data: {
        model,
        maxTokens: requestBody.generationConfig.maxOutputTokens,
        temperature: requestBody.generationConfig.temperature,
        stopSequences: options?.stopSequences,
        systemPromptLength: systemMessage?.content.length || 0,
        messageCount: vertexMessages.length,
        messages: messages.map(m => ({
          role: m.role,
          contentLength: m.content.length,
          contentPreview: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
          metadata: m.metadata
        }))
      }
    });

    // Retry logic
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[VertexProvider] Retry attempt ${attempt}/${this.maxRetries} after exponential backoff`);
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Vertex AI API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        
        // Extract content from response
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Extract token usage if available
        // Note: For Gemini 3, totalTokenCount includes thoughtsTokenCount (extended thinking)
        const inputTokens = data.usageMetadata?.promptTokenCount || 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        const thoughtsTokens = data.usageMetadata?.thoughtsTokenCount || 0;
        const totalTokens = data.usageMetadata?.totalTokenCount || (inputTokens + outputTokens);

        // Trace the response
        tracer?.record({
          id: `llm-response-${Date.now()}`,
          timestamp: Date.now(),
          level: 'info',
          category: TraceCategory.LLM_RESPONSE,
          component: 'VertexProvider',
          operation: 'generate',
          data: {
            model,
            contentLength: content.length,
            contentPreview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
            inputTokens,
            outputTokens,
            totalTokens,
            thoughtsTokens: thoughtsTokens > 0 ? thoughtsTokens : undefined,
            finishReason: data.candidates?.[0]?.finishReason,
            attempt: attempt > 0 ? attempt : undefined
          }
        });

        return {
          content,
          tokensUsed: totalTokens,
          modelId: model
        };
      } catch (error) {
        lastError = error;
        
        // Log the error immediately
        console.error(`[VertexProvider] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`, 
          error instanceof Error ? error.message : error);
        
        // Determine if we should retry
        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);
        
        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          console.log(`[VertexProvider] Will retry in ${delay}ms (exponential backoff)`);
        } else if (attempt === this.maxRetries) {
          console.error(`[VertexProvider] Max retries (${this.maxRetries}) exceeded`);
        } else {
          console.error(`[VertexProvider] Error is not retryable`);
        }
        
        // Trace the error
        tracer?.record({
          id: `llm-error-${Date.now()}`,
          timestamp: Date.now(),
          level: shouldRetry ? 'warn' : 'error',
          category: TraceCategory.LLM_ERROR,
          component: 'VertexProvider',
          operation: 'generate',
          data: {
            error: error instanceof Error ? error.message : String(error),
            model,
            messageCount: vertexMessages.length,
            attempt,
            willRetry: shouldRetry
          }
        });
        
        if (shouldRetry) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = this.retryDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Not retryable or max retries reached
        break;
      }
    }
    
    // Throw the last error
    throw lastError;
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for Gemini
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'vertex-ai';
  }

  getCapabilities(): {
    supportsPrefill: boolean;
    supportsCaching: boolean;
    maxContextLength?: number;
  } {
    return {
      supportsPrefill: false, // Gemini doesn't support prefill like Claude
      supportsCaching: false, // We haven't implemented caching for Vertex yet
      maxContextLength: 1000000 // Gemini 1.5 Pro has 1M context window
    };
  }
  
  private isRetryableError(error: any): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      
      // Check for HTTP status codes in error message
      if (message.includes('429') || // Rate limit
          message.includes('500') || // Internal server error
          message.includes('502') || // Bad gateway
          message.includes('503') || // Service unavailable
          message.includes('504')) { // Gateway timeout
        return true;
      }
      
      // Retry on connection-related errors
      if (message.includes('connection') || 
          message.includes('timeout') || 
          message.includes('econnreset') ||
          message.includes('socket') ||
          message.includes('network')) {
        return true;
      }
    }
    
    return false;
  }
}
