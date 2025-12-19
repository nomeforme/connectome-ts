/**
 * Anthropic LLM Provider
 * 
 * Implements the LLMProvider interface for Anthropic's Claude models.
 * Supports both message-based and prefill modes.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamChunk
} from './llm-interface';
import { getGlobalTracer, TraceCategory } from '../tracing';

export interface AnthropicProviderConfig {
  apiKey: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey
    });
    this.defaultModel = config.defaultModel || 'claude-sonnet-4-0';
    this.defaultMaxTokens = config.defaultMaxTokens || 1000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000; // 1 second
  }

  async generate(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    // Filter out cache markers - they don't go to the API
    const apiMessages = messages.filter(m => m.role !== 'cache');
    
    // Build stop sequences, including format-based ones
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Determine if we should use prefill mode
    const lastMessage = apiMessages[apiMessages.length - 1];
    const usesPrefill = lastMessage?.role === 'assistant' && lastMessage.content.length > 0;
    
    // Convert to Anthropic format
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');
    
    // Build Anthropic messages
    const anthropicMessages: Anthropic.MessageParam[] = await Promise.all(
      conversationMessages.map(async (msg, idx) => {
        // Handle cache control metadata
        const cacheControl = msg.metadata?.cacheControl;
        const attachments = msg.metadata?.attachments;
        
        // For assistant messages, trim trailing whitespace (Anthropic requirement)
        const messageContent = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;
        
        let content: Anthropic.MessageParam['content'];
        
        // Check if we have image attachments
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          // Build multi-modal content blocks
          const contentBlocks: Anthropic.MessageParam['content'] = [];
          
          // Add attachments (images and documents)
          for (const attachment of attachments) {
            const contentType = attachment.contentType || attachment.mimeType || '';
            
            // Check if this is an image
            const isImage = contentType.startsWith('image/') || attachment.type === 'image';
            
            // Check if this is a supported document
            const isDocument = contentType === 'application/pdf' || 
                              contentType === 'text/plain' ||
                              attachment.type === 'document';
            
            if (isImage) {
              try {
                // Get URL (Discord format or legacy format)
                const imageUrl = attachment.url || attachment.data;
                
                if (!imageUrl) {
                  console.warn('[AnthropicProvider] Image attachment has no URL or data, skipping');
                  continue;
                }
                
                // Fetch the image and convert to base64 (if it's a URL)
                let imageData: string;
                if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                  imageData = await this.fetchImageAsBase64(imageUrl);
                } else {
                  // Assume it's already base64
                  imageData = imageUrl;
                }
                
                // Determine media type
                const mediaType = this.getAnthropicMediaType(contentType);
                
                if (mediaType) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: imageData
                    }
                  } as Anthropic.ImageBlockParam);
                  
                  console.log(`[AnthropicProvider] Added image attachment: ${attachment.name || 'unnamed'} (${contentType})`);
                }
              } catch (error) {
                console.error(`[AnthropicProvider] Failed to process image attachment:`, error);
                // Continue without this image
              }
            } else if (isDocument) {
              try {
                // Get URL
                const documentUrl = attachment.url || attachment.data;
                
                if (!documentUrl) {
                  console.warn('[AnthropicProvider] Document attachment has no URL or data, skipping');
                  continue;
                }
                
                // Fetch the document and convert to base64 (if it's a URL)
                let documentData: string;
                if (documentUrl.startsWith('http://') || documentUrl.startsWith('https://')) {
                  documentData = await this.fetchImageAsBase64(documentUrl); // Same method works for any file
                } else {
                  // Assume it's already base64
                  documentData = documentUrl;
                }
                
                // Determine document media type
                const docMediaType = this.getAnthropicDocumentMediaType(contentType);
                
                if (docMediaType) {
                  contentBlocks.push({
                    type: 'document',
                    source: {
                      type: 'base64',
                      media_type: docMediaType,
                      data: documentData
                    }
                  } as Anthropic.DocumentBlockParam);
                  
                  console.log(`[AnthropicProvider] Added document attachment: ${attachment.name || 'unnamed'} (${contentType})`);
                }
              } catch (error) {
                console.error(`[AnthropicProvider] Failed to process document attachment:`, error);
                // Continue without this document
              }
            }
          }
          
          // Add text content after images
          if (cacheControl && this.getCapabilities().supportsCaching) {
            contentBlocks.push({
              type: 'text',
              text: messageContent,
              cache_control: {
                type: cacheControl.type as 'ephemeral'
              }
            } as Anthropic.TextBlockParam);
          } else {
            contentBlocks.push({
              type: 'text',
              text: messageContent
            } as Anthropic.TextBlockParam);
          }
          
          content = contentBlocks;
        } else if (cacheControl && this.getCapabilities().supportsCaching) {
          // Text only with cache control
          content = [{
            type: 'text',
            text: messageContent,
            cache_control: {
              type: cacheControl.type as 'ephemeral'
            }
          }];
        } else {
          // Plain text
          content = messageContent;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content
        };
      })
    );

    // Prepare request for tracing
    const request = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      temperature: options?.temperature ?? 1.0,
      stop_sequences: stopSequences.length > 0 ? stopSequences : undefined,
      system: systemMessage || undefined,
      messages: anthropicMessages
    };
    
    // Log and trace the request
    console.log('[AnthropicProvider:generate] Starting request...');
    const tracer = getGlobalTracer();
    tracer?.record({
      id: `llm-request-${Date.now()}`,
      timestamp: Date.now(),
      level: 'info',
      category: TraceCategory.LLM_REQUEST,
      component: 'AnthropicProvider',
      operation: 'generate',
      data: {
        model: request.model,
        maxTokens: request.max_tokens,
        temperature: request.temperature,
        stopSequences: request.stop_sequences,
        systemPromptLength: systemMessage.length,
        messageCount: anthropicMessages.length,
        usesPrefill,
        // Full messages for debugging
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
          console.log(`[AnthropicProvider] Retry attempt ${attempt}/${this.maxRetries} after exponential backoff`);
        }
        const response = await this.client.messages.create(request);

        // Extract text content
        const content = response.content
          .filter(block => block.type === 'text')
          .map(block => (block as Anthropic.TextBlock).text)
          .join('');
        
        // Trace the response
        tracer?.record({
          id: `llm-response-${Date.now()}`,
          timestamp: Date.now(),
          level: 'info',
          category: TraceCategory.LLM_RESPONSE,
          component: 'AnthropicProvider',
          operation: 'generate',
          data: {
            model: response.model,
            contentLength: content.length,
            contentPreview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
            stopReason: response.stop_reason,
            stopSequence: response.stop_sequence,
            attempt: attempt > 0 ? attempt : undefined
          }
        });

        return {
          content,
          tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
          modelId: response.model
        };
      } catch (error) {
        lastError = error;
        
        // Log the error immediately
        console.error(`[AnthropicProvider] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`, 
          error instanceof Error ? error.message : error);
        
        // Determine if we should retry
        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);
        
        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          console.log(`[AnthropicProvider] Will retry in ${delay}ms (exponential backoff)`);
        } else if (attempt === this.maxRetries) {
          console.error(`[AnthropicProvider] Max retries (${this.maxRetries}) exceeded`);
        } else {
          console.error(`[AnthropicProvider] Error is not retryable`);
        }
        
        // Trace the error
        tracer?.record({
          id: `llm-error-${Date.now()}`,
          timestamp: Date.now(),
          level: shouldRetry ? 'warn' : 'error',
          category: TraceCategory.LLM_ERROR,
          component: 'AnthropicProvider',
          operation: 'generate',
          data: {
            error: error instanceof Error ? error.message : String(error),
            errorType: error instanceof Anthropic.APIError ? 'APIError' : 'UnknownError',
            model: request.model,
            messageCount: anthropicMessages.length,
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
    if (lastError instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error: ${lastError.message}`);
    }
    throw lastError;
  }

  async *generateStream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamChunk> {
    // Filter out cache markers - they don't go to the API
    const apiMessages = messages.filter(m => m.role !== 'cache');

    // Build stop sequences, including format-based ones
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Convert to Anthropic format
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build Anthropic messages (simplified - no attachments in streaming for now)
    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map(msg => {
      const messageContent = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;
      return {
        role: msg.role as 'user' | 'assistant',
        content: messageContent
      };
    });

    const request = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      temperature: options?.temperature ?? 1.0,
      stop_sequences: stopSequences.length > 0 ? stopSequences : undefined,
      system: systemMessage || undefined,
      messages: anthropicMessages
    };

    console.log('[AnthropicProvider:generateStream] Starting streaming request...');
    const tracer = getGlobalTracer();
    tracer?.record({
      id: `llm-stream-request-${Date.now()}`,
      timestamp: Date.now(),
      level: 'info',
      category: TraceCategory.LLM_REQUEST,
      component: 'AnthropicProvider',
      operation: 'generateStream',
      data: {
        model: request.model,
        maxTokens: request.max_tokens,
        temperature: request.temperature,
        stopSequences: request.stop_sequences,
        systemPromptLength: systemMessage.length,
        messageCount: anthropicMessages.length,
        streaming: true
      }
    });

    try {
      // Check if already aborted before starting
      if (options?.signal?.aborted) {
        console.log('[AnthropicProvider:generateStream] Request aborted before start');
        return;
      }

      const stream = this.client.messages.stream(request);

      // Set up abort handling if signal provided
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          console.log('[AnthropicProvider:generateStream] Abort signal received, aborting stream');
          stream.controller.abort();
        }, { once: true });
      }

      let totalContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let modelId = request.model;

      for await (const event of stream) {
        // Check for abort between events
        if (options?.signal?.aborted) {
          console.log('[AnthropicProvider:generateStream] Stream aborted mid-flight');
          return;
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            const content = delta.text;
            totalContent += content;
            yield {
              content,
              done: false
            };
          }
        } else if (event.type === 'message_start') {
          // Capture input tokens from message start
          if (event.message?.usage?.input_tokens) {
            inputTokens = event.message.usage.input_tokens;
          }
          if (event.message?.model) {
            modelId = event.message.model;
          }
        } else if (event.type === 'message_delta') {
          // Capture output tokens from message delta
          if (event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens;
          }
        }
      }

      // Emit final chunk with done=true and token info
      yield {
        content: '',
        done: true,
        tokensUsed: inputTokens + outputTokens,
        modelId
      };

      // Trace the completed stream
      tracer?.record({
        id: `llm-stream-response-${Date.now()}`,
        timestamp: Date.now(),
        level: 'info',
        category: TraceCategory.LLM_RESPONSE,
        component: 'AnthropicProvider',
        operation: 'generateStream',
        data: {
          model: modelId,
          contentLength: totalContent.length,
          contentPreview: totalContent.substring(0, 200) + (totalContent.length > 200 ? '...' : ''),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          streaming: true
        }
      });

    } catch (error) {
      console.error('[AnthropicProvider:generateStream] Stream error:', error);

      tracer?.record({
        id: `llm-stream-error-${Date.now()}`,
        timestamp: Date.now(),
        level: 'error',
        category: TraceCategory.LLM_ERROR,
        component: 'AnthropicProvider',
        operation: 'generateStream',
        data: {
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Anthropic.APIError ? 'APIError' : 'UnknownError',
          model: request.model,
          streaming: true
        }
      });

      throw error;
    }
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for Claude
    // In production, you'd use a proper tokenizer
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'anthropic';
  }

  getCapabilities(): {
    supportsPrefill: boolean;
    supportsCaching: boolean;
    supportsStreaming: boolean;
    maxContextLength?: number;
  } {
    return {
      supportsPrefill: true,
      supportsCaching: true,
      supportsStreaming: true,
      maxContextLength: 200000 // Claude 3 context window
    };
  }
  
  private isRetryableError(error: any): boolean {
    if (error instanceof Anthropic.APIError) {
      // Retry on connection errors, rate limits, and server errors
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (error.status && retryableStatuses.includes(error.status)) {
        return true;
      }
      
      // Retry on connection-related errors
      const message = error.message.toLowerCase();
      if (message.includes('connection') || 
          message.includes('timeout') || 
          message.includes('econnreset') ||
          message.includes('socket')) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Fetch an image from a URL and convert to base64
   */
  private async fetchImageAsBase64(url: string): Promise<string> {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.buffer();
    return buffer.toString('base64');
  }
  
  /**
   * Map content type to Anthropic's image media type format
   */
  private getAnthropicMediaType(contentType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    const normalized = contentType.toLowerCase();
    
    if (normalized.includes('jpeg') || normalized.includes('jpg')) {
      return 'image/jpeg';
    }
    if (normalized.includes('png')) {
      return 'image/png';
    }
    if (normalized.includes('gif')) {
      return 'image/gif';
    }
    if (normalized.includes('webp')) {
      return 'image/webp';
    }
    
    return null;
  }
  
  /**
   * Map content type to Anthropic's document media type format
   */
  private getAnthropicDocumentMediaType(contentType: string): 'application/pdf' | 'text/plain' | null {
    const normalized = contentType.toLowerCase();
    
    if (normalized.includes('pdf')) {
      return 'application/pdf';
    }
    if (normalized.includes('text/plain') || normalized.includes('text')) {
      return 'text/plain';
    }
    
    return null;
  }
}
