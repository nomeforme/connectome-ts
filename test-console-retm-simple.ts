/**
 * Simple test of Console RETM - automated (no user input)
 */

import {
  Space,
  Element,
  VEILStateManager,
  ConsoleAfferent,
  ConsoleInbound,
  ConsoleOutbound,
  AgentEffector,
  BasicAgent,
  MockLLMProvider,
  ContextRenderer
} from './src';
import { AfferentContext } from './src/spaces/component-types';

async function main() {
  console.log('=== Console RETM Test (Automated) ===\n');
  
  // Setup
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  // Create console element
  const consoleElem = new Element('console');
  space.addChild(consoleElem);
  
  // Create console afferent
  const consoleAfferent = new ConsoleAfferent();
  await consoleElem.addComponentAsync(consoleAfferent);
  
  // Create context WITHOUT readline (for automated testing)
  const context: AfferentContext<any> = {
    config: {
      streamId: 'console:test'
    },
    afferentId: 'console-test',
    emit: (event) => space.emit(event),
    emitError: (error) => console.error('[Error]:', error)
  };
  
  // Initialize but DON'T start (to avoid readline)
  await consoleAfferent.initialize(context);
  
  // Add receptors/effectors
  space.addReceptor(new ConsoleInbound());
  space.addEffector(new ConsoleOutbound());
  
  // Create agent
  const agentElem = new Element('agent');
  space.addChild(agentElem);
  
  const mockProvider = new MockLLMProvider();
  mockProvider.setResponses([
    "Hello! Console RETM is working!",
    "The architecture is clean and proper."
  ]);
  
  // Register LLM provider in space
  space.registerReference('llm.primary', mockProvider);
  
  const agent = new BasicAgent({
    name: 'TestAgent',
    systemPrompt: 'You are a test agent.'
  });
  
  // Set provider directly
  (agent as any).provider = mockProvider;
  
  space.addEffector(new AgentEffector(agentElem, agent));
  space.addTransform(new ContextRenderer(veilState));
  
  console.log('✅ Console RETM setup complete\n');
  
  // Simulate a console message by emitting the event directly
  console.log('1. Simulating user input...\n');
  space.emit({
    topic: 'console:message',
    source: consoleElem.getRef(),
    timestamp: Date.now(),
    payload: {
      messageId: 'test-msg-1',
      content: 'Hello agent!',
      streamId: 'console:test',
      streamType: 'console'
    }
  });
  
  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Check results
  const finalState = veilState.getState();
  console.log('\n2. Checking results...\n');
  console.log(`   Frames created: ${finalState.frameHistory.length}`);
  console.log(`   Facets in state: ${finalState.facets.size}`);
  
  // Find message facet
  const messageFacet = finalState.facets.get('test-msg-1');
  if (messageFacet) {
    console.log('   ✅ Message facet created');
  } else {
    console.log('   ❌ Message facet NOT created');
  }
  
  // Find speech facet
  const speechFacets = Array.from(finalState.facets.values()).filter(f => f.type === 'speech');
  console.log(`   Speech facets: ${speechFacets.length}`);
  
  if (speechFacets.length > 0) {
    console.log('   ✅ Agent responded with speech');
    const speech = speechFacets[0] as any;
    console.log(`   Response: "${speech.content}"`);
  } else {
    console.log('   ❌ No agent speech generated');
  }
  
  // Stop the afferent
  await consoleAfferent.stop();
  
  console.log('\n✅ Console RETM test complete!');
  process.exit(0);
}

main();
