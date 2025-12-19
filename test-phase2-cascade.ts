/**
 * Test that FLEX transforms can see changes from previous iterations
 * This verifies the fix where we apply deltas directly instead of creating frames
 */

import { Space } from './src/spaces/space';
import { VEILStateManager } from './src/veil/veil-state';
import { Component } from './src/spaces/component';
import { ExecutionContext } from './src/spaces/types';
import { ReadonlyVEILState, VEILDelta, SpaceEvent, Facet } from './src/spaces/receptor-effector-types';

// Receptor: Converts trigger events to facets
class TriggerReceptor extends Component {
  priority = 100;
  topics = ['test:trigger'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'test:trigger') return;

    console.log('[Receptor] Converting trigger event to facet');
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: 'trigger-event',
        type: 'event',
        content: 'Trigger event received',
        eventType: 'trigger'
      } as any
    });
  }
}

// Transform 1: Adds a counter facet when it sees a trigger
class CounterAdderTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;

    // Look for trigger facet
    const hasTrigger = Array.from(state.facets.values()).some(
      f => f.type === 'event' && (f as any).eventType === 'trigger'
    );

    // Check if counter already exists
    const hasCounter = state.facets.has('counter');

    if (hasTrigger && !hasCounter) {
      console.log('[Transform 1] Adding counter facet');
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: 'counter',
          type: 'state',
          content: 'Counter',
          state: { count: 0 }
        }
      });
    }
  }
}

// Transform 2: Increments counter when it sees it
class CounterIncrementerTransform extends Component {
  priority = 201;  // Higher priority to run after CounterAdderTransform

  execute(context: ExecutionContext): void {
    const { state } = context;

    const counter = state.facets.get('counter');

    if (counter && counter.type === 'state') {
      const currentCount = (counter as any).state?.count || 0;

      if (currentCount < 3) {
        console.log(`[Transform 2] Incrementing counter from ${currentCount} to ${currentCount + 1}`);
        this.addOperation({
          type: 'rewriteFacet',
          id: 'counter',
          changes: {
            state: { count: currentCount + 1 }
          }
        });
      }
    }
  }
}

async function runTest() {
  console.log('=== Phase 2 Cascade Test ===\n');
  
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  // Add receptor and transforms
  space.addReceptor(new TriggerReceptor());
  space.addTransform(new CounterAdderTransform());
  space.addTransform(new CounterIncrementerTransform());
  
  console.log('1. Emitting trigger event...\n');
  
  // Emit trigger event
  space.emit({
    topic: 'test:trigger',
    source: { elementId: 'test', elementPath: ['test'] },
    timestamp: Date.now(),
    payload: { type: 'trigger', eventType: 'trigger' }
  });
  
  // Wait for frame to process
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Check the final state
  const finalState = veilState.getState();
  const counter = finalState.facets.get('counter');
  
  console.log('\n2. Checking results...\n');
  
  if (!counter) {
    console.error('❌ FAIL: Counter facet not created');
    process.exit(1);
  }
  
  const finalCount = (counter as any).state?.count;
  console.log(`   Final counter value: ${finalCount}`);
  
  if (finalCount === 3) {
    console.log('\n✅ SUCCESS: Transform 2 saw changes from Transform 1 in each iteration!');
    console.log('   - Iteration 1: Transform 1 added counter (count=0)');
    console.log('   - Iteration 2: Transform 2 saw counter, incremented to 1');
    console.log('   - Iteration 3: Transform 2 saw updated counter, incremented to 2');
    console.log('   - Iteration 4: Transform 2 saw updated counter, incremented to 3');
    console.log('   - Iteration 5: Transform 2 saw count=3, stopped');
  } else {
    console.error(`\n❌ FAIL: Expected count=3, got count=${finalCount}`);
    console.error('   This means transforms could not see previous iteration changes!');
    process.exit(1);
  }
  
  // Check frame history
  console.log(`\n3. Frame history: ${finalState.frameHistory.length} frames`);
  
  if (finalState.frameHistory.length === 1) {
    console.log('   ✅ Correct: Only 1 frame created (not one per iteration)');
  } else {
    console.error(`   ❌ Wrong: Expected 1 frame, got ${finalState.frameHistory.length}`);
    process.exit(1);
  }
  
  // Check deltas in the single frame
  const frame = finalState.frameHistory[0];
  console.log(`   Frame has ${frame.deltas.length} deltas:`);
  frame.deltas.forEach((delta, i) => {
    if (delta.type === 'addFacet') {
      console.log(`     ${i + 1}. addFacet: ${(delta as any).facet.id}`);
    } else if (delta.type === 'rewriteFacet') {
      const count = (delta as any).changes?.state?.count;
      console.log(`     ${i + 1}. RewriteFacet: counter (count=${count})`);
    }
  });
  
  console.log('\n✅ All tests passed!');
  process.exit(0);
}

runTest();
