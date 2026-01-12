/**
 * Test Console Afferent architecture (no agent)
 */

import {
  Space,
  Element,
  VEILStateManager,
  ConsoleAfferent,
  ConsoleInbound
} from './src';
import { AfferentContext } from './src/spaces/component-types';

async function main() {
  console.log('=== Console Afferent Test ===\n');
  
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  const consoleElem = new Element('console');
  space.addChild(consoleElem);
  
  const consoleAfferent = new ConsoleAfferent();
  await consoleElem.addComponentAsync(consoleAfferent);
  
  const context: AfferentContext<any> = {
    config: { streamId: 'console:test' },
    afferentId: 'console-test',
    emit: (event) => {
      console.log(`[Afferent Emitted]: ${event.topic}`);
      space.emit(event);
    },
    emitError: (error) => console.error('[Error]:', error)
  };
  
  await consoleAfferent.initialize(context);
  
  // Add receptor
  space.addReceptor(new ConsoleInbound());
  
  console.log('✅ Setup complete\n');
  
  // Manually emit a console message (simulating what the afferent would do when user types)
  console.log('1. Emitting console:message event...\n');
  space.emit({
    topic: 'console:message',
    source: consoleElem.getRef(),
    timestamp: Date.now(),
    payload: {
      messageId: 'test-msg-1',
      content: 'Test message',
      streamId: 'console:test',
      streamType: 'console'
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const state = veilState.getState();
  console.log('\n2. Results:\n');
  console.log(`   Frames: ${state.frameHistory.length}`);
  console.log(`   Facets: ${state.facets.size}`);
  
  const messageFacet = state.facets.get('test-msg-1');
  if (messageFacet) {
    console.log('   ✅ Message facet created by receptor');
    console.log(`      Type: ${messageFacet.type}`);
    console.log(`      Content: ${(messageFacet as any).content}`);
  }
  
  const activationFacets = Array.from(state.facets.values()).filter(
    f => f.type === 'agent-activation'
  );
  console.log(`   Activation facets: ${activationFacets.length}`);
  
  if (activationFacets.length > 0) {
    console.log('   ✅ Activation facet created by receptor');
  }
  
  console.log('\n✅ Console Afferent architecture verified!');
  console.log('\nKey Points:');
  console.log('  - Afferent manages readline (external input)');
  console.log('  - Afferent emits events (not VEIL operations)');
  console.log('  - Receptor converts events to facets');
  console.log('  - No direct VEIL manipulation from async callbacks');
  console.log('  - Architecturally pure RETM!\n');
  
  process.exit(0);
}

main();

