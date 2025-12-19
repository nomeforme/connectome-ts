/**
 * Test SAFE RewriteFacet operations
 */

import { Space } from './src/spaces/space';
import { VEILStateManager } from './src/veil/veil-state';
import { Component } from './src/spaces/component';
import { ExecutionContext } from './src/spaces/types';
import { ReadonlyVEILState, VEILDelta, SpaceEvent, Facet } from './src/spaces/receptor-effector-types';

// SAFE Transform: Only changes facet when specific condition is met
class SafeHealthTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;

    const health = state.facets.get('health');
    if (!health || health.type !== 'state') return;

    const currentHealth = (health as any).state?.current;
    const status = (health as any).state?.status;

    // Only update if health is low AND status hasn't been updated yet
    if (currentHealth < 30 && status === 'healthy') {
      console.log('[SafeTransform] Health is low, updating status to "critical"');
      this.addOperation({
        type: 'rewriteFacet',
        id: 'health',
        changes: {
          state: { status: 'critical' }
        }
      });
    }
  }
}

// CONDITIONALLY SAFE Transform: Only increments until a limit
class ConditionalTimerTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;

    const timer = state.facets.get('timer-safe');
    if (!timer || timer.type !== 'state') return;

    const elapsed = (timer as any).state?.elapsed || 0;

    // SAFE: Only increment up to a limit
    if (elapsed < 5) {
      console.log(`[ConditionalTransform] Incrementing timer from ${elapsed} to ${elapsed + 1}`);
      this.addOperation({
        type: 'rewriteFacet',
        id: 'timer-safe',
        changes: {
          state: { elapsed: elapsed + 1 }
        }
      });
    }
  }
}

async function runTests() {
  console.log('=== SAFE RewriteFacet Tests ===\n');
  
  // Test 1: Conditional RewriteFacet
  console.log('Test 1: Conditional status update\n');
  const veilState1 = new VEILStateManager();
  const space1 = new Space(veilState1);
  
  space1.addReceptor({
    topics: ['test:safe'],
    transform: (event: SpaceEvent, state: ReadonlyVEILState): Facet[] => {
      console.log('[Receptor] Creating health facet with low health (25)');
      return [{
        id: 'health',
        type: 'state',
        content: 'Player Health',
        state: { current: 25, max: 100, status: 'healthy' }
      }];
    }
  });
  
  space1.addTransform(new SafeHealthTransform());
  
  space1.emit({
    topic: 'test:safe',
    source: { elementId: 'test', elementPath: ['test'] },
    timestamp: Date.now(),
    payload: {}
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const finalState1 = veilState1.getState();
  const finalHealth = finalState1.facets.get('health');
  const finalStatus = (finalHealth as any)?.state?.status;
  
  console.log(`   Final health status: ${finalStatus}`);
  
  if (finalStatus !== 'critical') {
    console.error('   ❌ Failed - status not updated\n');
    process.exit(1);
  }
  console.log('   ✅ Status updated once, no loop\n');
  
  // Test 2: Counter with limit
  console.log('Test 2: Counter with limit\n');
  const veilState2 = new VEILStateManager();
  const space2 = new Space(veilState2);
  
  space2.addReceptor({
    topics: ['test:conditional'],
    transform: (event: SpaceEvent, state: ReadonlyVEILState): Facet[] => {
      console.log('[Receptor] Creating timer-safe facet');
      return [{
        id: 'timer-safe',
        type: 'state',
        content: 'Safe Timer',
        state: { elapsed: 0 }
      }];
    }
  });
  
  space2.addTransform(new ConditionalTimerTransform());
  
  space2.emit({
    topic: 'test:conditional',
    source: { elementId: 'test', elementPath: ['test'] },
    timestamp: Date.now(),
    payload: {}
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const finalState2 = veilState2.getState();
  const timer = finalState2.facets.get('timer-safe');
  const elapsed = (timer as any)?.state?.elapsed;
  
  console.log(`   Final elapsed time: ${elapsed}`);
  
  if (elapsed !== 5) {
    console.error(`   ❌ Failed - expected elapsed=5, got ${elapsed}\n`);
    process.exit(1);
  }
  console.log('   ✅ Counter stopped at limit\n');
  
  const frameCount = finalState2.frameHistory.length;
  console.log(`   Frames created: ${frameCount}`);
  if (frameCount !== 1) {
    console.error(`   ❌ Wrong: Expected 1 frame, got ${frameCount}\n`);
    process.exit(1);
  }
  console.log('   ✅ Only 1 frame despite 6 iterations (0→1→2→3→4→5)\n');
  
  console.log('✅ All safe tests passed!\n');
  console.log('Key Lesson: Transforms MUST check conditions that become false after RewriteFacet');
}

runTests();
