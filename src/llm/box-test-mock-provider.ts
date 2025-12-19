/**
 * Box Test Mock Provider
 * Simulates an agent that creates boxes via @element-control.createBox action
 */

import { LLMProvider, LLMMessage, LLMResponse, LLMOptions, LLMStreamChunk } from './llm-interface';

export class BoxTestMockProvider implements LLMProvider {
  name = 'box-test-mock';
  private callCount = 0;
  
  constructor(private config?: any) {}
  
  async generate(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    this.callCount++;
    
    // Find the last user message
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMessage?.content || '';
    
    console.log(`[BoxTestMock] Call #${this.callCount}, user said: "${userText.substring(0, 80)}..."`);
    
    // Simulate agent calling createBox action based on user input
    let response: string;
    let toolUse: any = null;
    
    if (userText.toLowerCase().includes('create') && userText.toLowerCase().includes('box')) {
      // Extract box name from message
      const match = userText.match(/box.*?["']([^"']+)["']|box\s+(?:called|named)\s+([a-zA-Z0-9\s]+)/i);
      const boxName = match?.[1] || match?.[2] || 'Mystery Box';
      
      console.log(`[BoxTestMock] Detected box creation request: "${boxName}"`);
      
      // Simulate calling the createBox action
      response = `I'll create that box for you! Creating "${boxName}"...`;
      toolUse = {
        type: 'tool_use',
        id: `tool-${Date.now()}`,
        name: 'element-control.createBox',
        input: {
          boxName: boxName.trim()
        }
      };
    } else if (userText.toLowerCase().includes('list') && userText.toLowerCase().includes('box')) {
      response = `Here are the boxes I can see. To create a new box, just ask me to "create a box called <name>"`;
    } else {
      response = `Hello! I can create boxes for you. Try saying "create a box called Red Box" or "create a box called Blue Box"`;
    }
    
    // Build response with tool use embedded in content
    let finalContent = response;
    if (toolUse) {
      // Include the tool use in the response content as the agent would output it
      // Use {@element.action()} syntax (curly braces required to avoid conflicts with Discord @mentions)
      // Use named parameter so it matches the action handler's expected parameter name
      finalContent = `${response}\n\n{@element-control.createBox(boxName="${toolUse.input.boxName}")}`;
      console.log(`[BoxTestMock] Including action call in response`);
    }
    
    return {
      content: finalContent,
      tokensUsed: messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0) + finalContent.length / 4
    };
  }
  
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  
  getProviderName(): string {
    return 'box-test-mock';
  }
  
  getCapabilities() {
    return {
      supportsPrefill: false,
      supportsCaching: false,
      supportsStreaming: true
    };
  }

  /**
   * Streaming version - simulates streaming by breaking response into chunks
   */
  async *generateStream(
    messages: LLMMessage[],
    options?: LLMOptions
  ): AsyncIterable<LLMStreamChunk> {
    const response = await this.generate(messages, options);

    // Break response into word chunks
    const words = response.content.split(/(\s+)/);
    for (const word of words) {
      if (word.length > 0) {
        yield {
          content: word,
          done: false
        };
      }
    }

    // Final chunk
    yield {
      content: '',
      done: true,
      tokensUsed: response.tokensUsed,
      modelId: 'box-test-mock'
    };
  }
}

