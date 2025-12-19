/**
 * Test that RewriteFacet operations in FLEX transforms don't cause infinite loops
 *
 * This tests both:
 * 1. Safe RewriteFacet (with proper guards)
 * 2. Unsafe RewriteFacet (that would loop infinitely)
 */

import { Space } from './src/spaces/space';
import { VEILStateManager } from './src/veil/veil-state';
import { Component } from './src/spaces/component';
import { ExecutionContext } from './src/spaces/types';
import { ReadonlyVEILState, VEILDelta, SpaceEvent, Facet } from './src/spaces/receptor-effector-types';

// SAFE Transform: Only changes facet when specific condition is met
class SafeHealthTransform extends Component {
  priority = 200;
  private hasRun = false;

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

// UNSAFE Transform: Would loop infinitely if not caught
class UnsafeTimerTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;

    const timer = state.facets.get('timer');
    if (!timer || timer.type !== 'state') return;

    const elapsed = (timer as any).state?.elapsed || 0;

    // BAD: This will always increment, causing infinite loop!
    console.log(`[UnsafeTransform] Incrementing timer from ${elapsed} to ${elapsed + 1}`);
    this.addOperation({
      type: 'rewriteFacet',
      id: 'timer',
      changes: {
        state: { elapsed: elapsed + 1 }
      }
    });
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

async function testSafeRewriteFacet() {
  console.log('\n=== Test 1: Safe RewriteFacet ===\n');
  
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  // Receptor that creates low health facet
  space.addReceptor({
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
  
  space.addTransform(new SafeHealthTransform());
  
  console.log('Creating health facet with current=25...\n');
  space.emit({
    topic: 'test:safe',
    source: { elementId: 'test', elementPath: ['test'] },
    timestamp: Date.now(),
    payload: {}
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const finalState = veilState.getState();
  const finalHealth = finalState.facets.get('health');
  const finalStatus = (finalHealth as any)?.state?.status;
  
  console.log(`\nFinal health status: ${finalStatus}`);
  
  if (finalStatus === 'critical') {
    console.log('✅ Safe RewriteFacet worked - status updated once, no loop\n');
  } else {
    console.error('❌ Failed - status not updated\n');
    process.exit(1);
  }
}

async function testUnsafeRewriteFacet() {
  console.log('\n=== Test 2: Unsafe RewriteFacet (should hit iteration limit) ===\n');
  
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  // Receptor that creates timer facet
  space.addReceptor({
    topics: ['test:unsafe'],
    transform: (event: SpaceEvent, state: ReadonlyVEILState): Facet[] => {
      console.log('[Receptor] Creating timer facet');
      return [{
        id: 'timer',
        type: 'state',
        content: 'Timer',
        state: { elapsed: 0 }
      }];
    }
  });
  
  space.addTransform(new UnsafeTimerTransform());
  
  console.log('Creating timer facet - this will trigger infinite loop...\n');
  
  let errorMessage = '';
  
  // Listen for the error on the process
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    // Suppress error output during test
  };
  
  try {
    space.emit({
      topic: 'test:unsafe',
      source: { elementId: 'test', elementPath: ['test'] },
      timestamp: Date.now(),
      payload: {}
    });
    
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error: any) {
    errorMessage = error.message;
  } finally {
    console.error = originalConsoleError;
  }
  
  if (errorMessage.includes('exceeded maximum iterations')) {
    console.log('✅ Infinite loop caught by iteration limit!\n');
    console.log(`   Error: ${errorMessage.split('\n')[0]}\n`);
  } else {
    console.error('❌ Failed - infinite loop not caught\n');
    console.error(`   Got error: ${errorMessage}\n`);
    process.exit(1);
  }
}

async function testConditionalRewriteFacet() {
  console.log('\n=== Test 3: Conditional RewriteFacet (safe with limit) ===\n');
  
  const veilState = new VEILStateManager();
  const space = new Space(veilState);
  
  // Add a receptor that creates the timer-safe facet
  space.addReceptor({
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
  
  space.addTransform(new ConditionalTimerTransform());
  
  console.log('Creating timer with limit of 5...\n');
  space.emit({
    topic: 'test:conditional',
    source: { elementId: 'test', elementPath: ['test'] },
    timestamp: Date.now(),
    payload: {}
  });
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const finalState = veilState.getState();
  const timer = finalState.facets.get('timer-safe');
  const elapsed = (timer as any)?.state?.elapsed;
  
  console.log(`\nFinal elapsed time: ${elapsed}`);
  
  if (elapsed === 5) {
    console.log('✅ Conditional RewriteFacet worked - stopped at limit\n');
  } else {
    console.error(`❌ Failed - expected elapsed=5, got ${elapsed}\n`);
    process.exit(1);
  }
  
  // Check frame count
  const frameCount = finalState.frameHistory.length;
  console.log(`Frames created: ${frameCount}`);
  if (frameCount === 1) {
    console.log('✅ Correct: Only 1 frame despite 6 iterations (0→1→2→3→4→5)\n');
  } else {
    console.error(`❌ Wrong: Expected 1 frame, got ${frameCount}\n`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== RewriteFacet Loop Prevention Tests ===');
  
  await testSafeRewriteFacet();
  await testConditionalRewriteFacet();
  await testUnsafeRewriteFacet();
  
  console.log('\n✅ All tests passed!\n');
  console.log('Key Lessons:');
  console.log('1. Transforms MUST check conditions before RewriteFacet');
  console.log('2. Conditions should become false after the change');
  console.log('3. Iteration limit (100) catches infinite loops');
  console.log('4. Multiple iterations still produce only 1 frame\n');
}

runTests();
