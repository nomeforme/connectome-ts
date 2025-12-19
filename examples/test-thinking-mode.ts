/**
 * Test script for Thinking Mode Prefill
 * 
 * Demonstrates the "simulated thinking" feature that uses prefill to encourage
 * chain-of-thought reasoning. This is NOT Anthropic's Extended Thinking API
 * (which is incompatible with prefill), but rather a prefill-based approach.
 * 
 * Usage:
 *   npx ts-node examples/test-thinking-mode.ts
 *   
 * With real API:
 *   ANTHROPIC_API_KEY=your-key npx ts-node examples/test-thinking-mode.ts
 */

import { AnthropicProvider } from '../src/llm/anthropic-provider';
import { MockLLMProvider } from '../src/llm/mock-llm-provider';
import { LLMProvider, LLMMessage } from '../src/llm/llm-interface';
import { FrameTrackingHUD } from '../src/hud/frame-tracking-hud';
import { VEILStateManager } from '../src/veil/veil-state';
import { Frame, createDefaultTransition } from '../src/veil/types';

// Create provider based on environment
function createProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (apiKey) {
    console.log('✅ Using Anthropic provider with API key');
    return new AnthropicProvider({
      apiKey,
      defaultModel: 'claude-sonnet-4-20250514'
    });
  } else {
    console.log('⚠️  No ANTHROPIC_API_KEY found, using mock provider');
    console.log('   Set ANTHROPIC_API_KEY to test with real API\n');
    return new MockLLMProvider();
  }
}

async function testThinkingModeDirect() {
  console.log('\n=== Direct LLM Thinking Mode Test ===\n');
  
  const provider = createProvider();
  
  // Test thinking mode by prefilling with <thinking> tag
  console.log('Testing prefill with <thinking> tag...');
  console.log('The model should produce reasoning in thinking tags, then respond.\n');
  
  const systemPrompt = `You are a helpful assistant that thinks through problems step by step.
When you see <thinking> tags inside your <my_turn>, use them to reason through the problem before responding.
After closing </thinking>, provide your actual response, then close with </my_turn>.

Format:
<my_turn>
<thinking>
Your internal reasoning here...
</thinking>
Your response to the user
</my_turn>`;

  // Prefill with both <my_turn> and <thinking> tags
  const prefill = '<my_turn>\n<thinking>\n';
  
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'What is 15% of 240?' },
    { role: 'assistant', content: prefill }
  ];
  
  console.log('Messages being sent:');
  messages.forEach((m, i) => {
    const preview = m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content;
    console.log(`  [${i}] ${m.role}: ${preview.replace(/\n/g, '\\n')}`);
  });
  console.log();
  
  try {
    const response = await provider.generate(messages, {
      maxTokens: 500,
      temperature: 0.7,
      stopSequences: ['</my_turn>'],
      formatConfig: {
        assistant: {
          prefix: '<my_turn>\n',
          suffix: '\n</my_turn>'
        },
        thinking: {
          enabled: true,
          openTag: '<thinking>\n',
          closeTag: '\n</thinking>\n'
        }
      }
    });
    
    console.log('Response (prepended with prefill):');
    console.log('─'.repeat(60));
    // The response continues from the prefill, so prepend it
    console.log(prefill + response.content);
    console.log('─'.repeat(60));
    
    if (response.tokensUsed) {
      console.log(`\nTokens used: ${response.tokensUsed}`);
    }
    
    // Analyze the response
    const hasThinkingClose = response.content.includes('</thinking>');
    const hasMyTurn = response.content.includes('<my_turn>');
    
    console.log('\nAnalysis:');
    console.log(`  ✓ Prefill with <thinking> applied`);
    console.log(`  ${hasThinkingClose ? '✓' : '✗'} Response contains </thinking>`);
    console.log(`  ${hasMyTurn ? '✓' : '✗'} Response contains <my_turn>`);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testThinkingModeViaHUD() {
  console.log('\n=== HUD-Based Thinking Mode Test ===\n');
  
  const hud = new FrameTrackingHUD();
  const veilStateManager = new VEILStateManager();
  
  // Create a simple frame with a user message via delta
  const timestamp = new Date().toISOString();
  const frames: Frame[] = [
    {
      sequence: 1,
      timestamp,
      events: [],
      deltas: [
        {
          type: 'addFacet',
          facet: {
            id: 'user-msg-1',
            type: 'speech',
            displayName: 'user',
            content: 'Explain why the sky is blue in one sentence.'
          }
        }
      ],
      transition: createDefaultTransition(1, timestamp)
    }
  ];
  
  console.log('Rendering context with thinking mode DISABLED...');
  const contextWithoutThinking = hud.render(
    frames,
    new Map(),
    veilStateManager,
    undefined,
    {
      systemPrompt: 'You are a helpful assistant.',
      formatConfig: {
        assistant: {
          prefix: '<my_turn>\n',
          suffix: '\n</my_turn>'
        }
      }
    }
  );
  
  const lastMsgWithout = contextWithoutThinking.messages[contextWithoutThinking.messages.length - 1];
  console.log(`Last message role: ${lastMsgWithout.role}`);
  console.log(`Last message content: "${lastMsgWithout.content.replace(/\n/g, '\\n')}"`);
  
  console.log('\nRendering context with thinking mode ENABLED...');
  const contextWithThinking = hud.render(
    frames,
    new Map(),
    veilStateManager,
    undefined,
    {
      systemPrompt: 'You are a helpful assistant.',
      formatConfig: {
        assistant: {
          prefix: '<my_turn>\n',
          suffix: '\n</my_turn>'
        },
        thinking: {
          enabled: true,
          openTag: '<thinking>\n',
          closeTag: '\n</thinking>\n'
        }
      }
    }
  );
  
  const lastMsgWith = contextWithThinking.messages[contextWithThinking.messages.length - 1];
  console.log(`Last message role: ${lastMsgWith.role}`);
  console.log(`Last message content: "${lastMsgWith.content.replace(/\n/g, '\\n')}"`);
  
  // Verify the prefill - should be <my_turn>\n<thinking>\n
  const expectedThinkingPrefill = '<my_turn>\n<thinking>\n';
  const prefillHasBoth = lastMsgWith.role === 'assistant' && lastMsgWith.content === expectedThinkingPrefill;
  console.log(`\n${prefillHasBoth ? '✓' : '✗'} Thinking mode prefill is: "<my_turn>\\n<thinking>\\n"`);
  
  // Verify regular prefill uses only <my_turn>
  const expectedRegularPrefill = '<my_turn>\n';
  const regularPrefillIsMyTurn = lastMsgWithout.role === 'assistant' && lastMsgWithout.content === expectedRegularPrefill;
  console.log(`${regularPrefillIsMyTurn ? '✓' : '✗'} Regular prefill is: "<my_turn>\\n"`);
  
  // Show what the model's output structure would look like
  console.log(`\n📋 Expected model output structure with thinking mode:`);
  console.log(`   <my_turn>`);
  console.log(`   <thinking>`);
  console.log(`   [model reasoning here...]`);
  console.log(`   </thinking>`);
  console.log(`   [actual response here...]`);
  console.log(`   </my_turn>  ← stop sequence`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         Thinking Mode Prefill Test Suite                  ║');
  console.log('║                                                           ║');
  console.log('║  This tests "simulated thinking" via prefill - NOT the   ║');
  console.log('║  official Anthropic Extended Thinking API.               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  // Test 1: HUD-level rendering (no API call needed)
  await testThinkingModeViaHUD();
  
  // Test 2: Direct LLM call with thinking mode
  await testThinkingModeDirect();
  
  console.log('\n=== Tests Complete ===\n');
}

main().catch(console.error);

