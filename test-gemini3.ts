/**
 * Test script for Gemini 3 via Vertex AI
 * 
 * Usage: npx tsx test-gemini3.ts
 */

import { VertexProvider } from './src/llm/vertex-provider';
import { LLMMessage } from './src/llm/llm-interface';

async function main() {
  console.log('🧪 Testing Gemini 3 via Vertex AI...\n');

  // Create the provider with the provided credentials
  const provider = new VertexProvider({
    apiKey: 'AQ.Ab8RN6I5Ck7BLXBMYst8uQQgiMbFaFmx2Cb6IIVsY3ljRQ1iNg',
    defaultModel: 'gemini-3-pro-preview',
    defaultMaxTokens: 1000,
    maxRetries: 2
  });

  console.log('Provider capabilities:', provider.getCapabilities());
  console.log();

  // Test 1: Simple greeting
  console.log('📝 Test 1: Simple greeting');
  const messages1: LLMMessage[] = [
    {
      role: 'user',
      content: 'Hello! Please introduce yourself in 2-3 sentences.'
    }
  ];

  try {
    const response1 = await provider.generate(messages1, {
      temperature: 0.7,
      maxTokens: 500
    });
    
    console.log('✅ Response:', response1.content);
    console.log('📊 Tokens used:', response1.tokensUsed);
    console.log('🎯 Model:', response1.modelId);
    console.log();
  } catch (error) {
    console.error('❌ Test 1 failed:', error);
    console.log();
  }

  // Test 2: Reasoning task
  console.log('📝 Test 2: Simple reasoning');
  const messages2: LLMMessage[] = [
    {
      role: 'system',
      content: 'You are a helpful assistant that explains things clearly and concisely.'
    },
    {
      role: 'user',
      content: 'What is 15 * 24? Show your work.'
    }
  ];

  try {
    const response2 = await provider.generate(messages2, {
      temperature: 0.2,
      maxTokens: 2000
    });
    
    console.log('✅ Response:', response2.content);
    console.log('📊 Tokens used:', response2.tokensUsed);
    console.log();
  } catch (error) {
    console.error('❌ Test 2 failed:', error);
    console.log();
  }

  // Test 3: Multi-turn conversation
  console.log('📝 Test 3: Multi-turn conversation');
  const messages3: LLMMessage[] = [
    {
      role: 'system',
      content: 'You are a friendly conversational AI.'
    },
    {
      role: 'user',
      content: 'What are your capabilities?'
    },
    {
      role: 'assistant',
      content: 'I can help with a wide range of tasks including answering questions, writing, analysis, coding, and creative projects. What would you like help with?'
    },
    {
      role: 'user',
      content: 'Can you write a haiku about digital consciousness?'
    }
  ];

  try {
    const response3 = await provider.generate(messages3, {
      temperature: 1.0,
      maxTokens: 1000
    });
    
    console.log('✅ Response:', response3.content);
    console.log('📊 Tokens used:', response3.tokensUsed);
    console.log();
  } catch (error) {
    console.error('❌ Test 3 failed:', error);
    console.log();
  }

  console.log('✨ Testing complete!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

