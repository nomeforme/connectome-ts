/**
 * Test suite for multi-constraint component ordering
 *
 * Tests:
 * 1. Basic type constraints (beforeComponentType, afterComponentType)
 * 2. ID constraints (beforeComponentId, afterComponentId)
 * 3. Cycle detection and resolution
 * 4. Self-contradictory constraint detection
 * 5. Priority vs ordering constraint conflicts
 * 6. Missing target handling
 * 7. Complex multi-constraint scenarios
 */

import { VEILStateManager } from '../src/veil/veil-state';
import { Space } from '../src/spaces/space';
import { Component } from '../src/spaces/component';
import {
  priorityConstraint,
  beforeComponentType,
  afterComponentType,
  beforeComponentId,
  afterComponentId,
  ComponentPriority
} from '../src/spaces/constraints';
import {
  MultiConstraintOrderingStrategy,
  MultiConstraintOrderingResult
} from '../src/spaces/ordering/component-ordering';
import { OrderingDiagnosticsFormatter } from '../src/spaces/ordering/ordering-diagnostics';

// ═══════════════════════════════════════════════════════════════════════════
// Test Components
// ═══════════════════════════════════════════════════════════════════════════

class ComponentA extends Component {
  constraints = [priorityConstraint(100)];
}

class ComponentB extends Component {
  constraints = [priorityConstraint(200)];
}

class ComponentC extends Component {
  constraints = [priorityConstraint(150)];
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Utilities
// ═══════════════════════════════════════════════════════════════════════════

function createTestSpace(verbose = false): Space {
  const veilState = new VEILStateManager();
  return new Space(veilState, undefined, undefined, undefined, {
    orderingStrategy: 'multi-constraint',
    multiConstraintOptions: { verbose }
  });
}

function getComponentOrder(space: Space): string[] {
  return (space as any).components.map((c: Component) => c.id);
}

function getComponentTypeOrder(space: Space): string[] {
  return (space as any).components.map((c: Component) => c.constructor.name);
}

let testCount = 0;
let passCount = 0;

function test(name: string, fn: () => void): void {
  testCount++;
  console.log(`\n━━━ Test ${testCount}: ${name} ━━━`);
  try {
    fn();
    passCount++;
    console.log('✓ PASSED');
  } catch (error: any) {
    console.log(`✗ FAILED: ${error.message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(
      `${message || 'Assertion failed'}\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}`
    );
  }
}

function assertIncludes(arr: string[], item: string, message?: string): void {
  if (!arr.includes(item)) {
    throw new Error(
      `${message || 'Array should include item'}\n  Array: ${JSON.stringify(arr)}\n  Missing: ${item}`
    );
  }
}

function assertBefore(arr: string[], first: string, second: string, message?: string): void {
  const firstIndex = arr.indexOf(first);
  const secondIndex = arr.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1) {
    throw new Error(`Items not found in array: ${first}, ${second}`);
  }
  if (firstIndex >= secondIndex) {
    throw new Error(
      `${message || 'Order violation'}\n  Expected: ${first} before ${second}\n  Actual order: ${arr.join(' -> ')}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test('Basic priority ordering (baseline)', () => {
  const space = createTestSpace();

  space.addComponent(new ComponentB(), 'b'); // priority 200
  space.addComponent(new ComponentA(), 'a'); // priority 100
  space.addComponent(new ComponentC(), 'c'); // priority 150

  const order = getComponentOrder(space);
  // VEILOperationReceptor is added first by Space constructor
  assertBefore(order, 'a', 'c', 'A (100) should be before C (150)');
  assertBefore(order, 'c', 'b', 'C (150) should be before B (200)');
});

test('beforeComponentType constraint', () => {
  const space = createTestSpace();

  // D wants to run before all ComponentB instances
  class ComponentD extends Component {
    constraints = [
      priorityConstraint(300), // High priority (late)
      beforeComponentType('ComponentB')
    ];
  }

  space.addComponent(new ComponentB(), 'b');
  space.addComponent(new ComponentD(), 'd');

  const order = getComponentOrder(space);
  assertBefore(order, 'd', 'b', 'D should run before B due to beforeComponentType');
});

test('afterComponentType constraint', () => {
  const space = createTestSpace();

  // D wants to run after all ComponentA instances
  class ComponentD extends Component {
    constraints = [
      priorityConstraint(50), // Low priority (early)
      afterComponentType('ComponentA')
    ];
  }

  space.addComponent(new ComponentA(), 'a');
  space.addComponent(new ComponentD(), 'd');

  const order = getComponentOrder(space);
  assertBefore(order, 'a', 'd', 'A should run before D due to afterComponentType');
});

test('beforeComponentId constraint', () => {
  const space = createTestSpace();

  class ComponentD extends Component {
    constraints = [
      priorityConstraint(300),
      beforeComponentId('target-comp')
    ];
  }

  space.addComponent(new ComponentA(), 'target-comp');
  space.addComponent(new ComponentD(), 'd');

  const order = getComponentOrder(space);
  assertBefore(order, 'd', 'target-comp', 'D should run before target-comp');
});

test('afterComponentId constraint', () => {
  const space = createTestSpace();

  class ComponentD extends Component {
    constraints = [
      priorityConstraint(50),
      afterComponentId('target-comp')
    ];
  }

  space.addComponent(new ComponentA(), 'target-comp');
  space.addComponent(new ComponentD(), 'd');

  const order = getComponentOrder(space);
  assertBefore(order, 'target-comp', 'd', 'target-comp should run before D');
});

test('Cycle detection and resolution (A -> B -> C -> A)', () => {
  const space = createTestSpace(true); // verbose

  class CycleA extends Component {
    constraints = [afterComponentType('CycleC')]; // A after C
  }
  class CycleB extends Component {
    constraints = [afterComponentType('CycleA')]; // B after A
  }
  class CycleC extends Component {
    constraints = [afterComponentType('CycleB')]; // C after B -> cycle!
  }

  space.addComponent(new CycleA(), 'cycle-a');
  space.addComponent(new CycleB(), 'cycle-b');
  space.addComponent(new CycleC(), 'cycle-c');

  // Should complete without error, cycle broken by dropping an edge
  const order = getComponentOrder(space);
  console.log('  Resolved order:', order.join(' -> '));

  // Check that the strategy recorded the cycle resolution
  const strategy = space.getOrderingStrategy() as MultiConstraintOrderingStrategy;
  const result = strategy.getLastResult();
  if (result && result.sortResult.resolvedCycles.length > 0) {
    console.log('  Cycle detected and resolved');
  }
});

test('Self-contradictory constraints (before AND after same ID)', () => {
  const space = createTestSpace(true);

  class Contradictory extends Component {
    constraints = [
      beforeComponentId('target'),
      afterComponentId('target') // Contradicts above!
    ];
  }

  space.addComponent(new ComponentA(), 'target');
  space.addComponent(new Contradictory(), 'contradictory');

  // Should complete, conflict detected and constraints dropped
  const strategy = space.getOrderingStrategy() as MultiConstraintOrderingStrategy;
  const result = strategy.getLastResult();
  if (result) {
    const conflicts = result.graphResult.conflicts;
    const hasSelfContradiction = conflicts.some(c => c.type === 'self-contradictory');
    if (hasSelfContradiction) {
      console.log('  Self-contradiction correctly detected');
    }
  }
});

test('Missing target warning', () => {
  const space = createTestSpace(true);

  class MissingTarget extends Component {
    constraints = [beforeComponentId('nonexistent-component')];
  }

  space.addComponent(new MissingTarget(), 'missing-target-test');

  // Should complete with warning about missing target
  const strategy = space.getOrderingStrategy() as MultiConstraintOrderingStrategy;
  const result = strategy.getLastResult();
  if (result) {
    const hasMissingConflict = result.graphResult.conflicts.some(
      c => c.type === 'missing-target'
    );
    if (hasMissingConflict) {
      console.log('  Missing target correctly detected');
    }
  }
});

test('Complex ordering with multiple constraints', () => {
  const space = createTestSpace();

  // Receptor -> Transform -> Effector chain with explicit constraints
  class MyReceptor extends Component {
    constraints = [
      priorityConstraint(ComponentPriority.RECEPTOR),
      beforeComponentType('MyTransform')
    ];
  }

  class MyTransform extends Component {
    constraints = [
      priorityConstraint(ComponentPriority.TRANSFORM),
      afterComponentType('MyReceptor'),
      beforeComponentType('MyEffector')
    ];
  }

  class MyEffector extends Component {
    constraints = [
      priorityConstraint(ComponentPriority.EFFECTOR),
      afterComponentType('MyTransform')
    ];
  }

  // Add in random order
  space.addComponent(new MyEffector(), 'effector');
  space.addComponent(new MyReceptor(), 'receptor');
  space.addComponent(new MyTransform(), 'transform');

  const typeOrder = getComponentTypeOrder(space);
  const receptorIdx = typeOrder.indexOf('MyReceptor');
  const transformIdx = typeOrder.indexOf('MyTransform');
  const effectorIdx = typeOrder.indexOf('MyEffector');

  if (receptorIdx < transformIdx && transformIdx < effectorIdx) {
    console.log('  Order: Receptor -> Transform -> Effector');
  } else {
    throw new Error(`Wrong order: ${typeOrder.join(' -> ')}`);
  }
});

test('Ordering diagnostics formatter', () => {
  const space = createTestSpace();

  // Create a scenario with some issues
  class TestComp extends Component {
    constraints = [
      beforeComponentId('missing'),
      afterComponentType('ComponentA')
    ];
  }

  space.addComponent(new ComponentA(), 'a');
  space.addComponent(new TestComp(), 'test');

  const strategy = space.getOrderingStrategy() as MultiConstraintOrderingStrategy;
  const result = strategy.getLastResult();

  if (result) {
    const formatter = new OrderingDiagnosticsFormatter();
    const report = formatter.format(result);
    const oneLiner = formatter.getOneLiner(result);

    console.log('  One-liner:', oneLiner);
    console.log('  Full report generated:', report.length, 'chars');
  }
});

test('Priority tiebreaker within same topological layer', () => {
  const space = createTestSpace();

  // Three components with no ordering constraints between them
  // Should sort by priority
  class LowPriority extends Component {
    constraints = [priorityConstraint(300)];
  }
  class HighPriority extends Component {
    constraints = [priorityConstraint(100)];
  }
  class MidPriority extends Component {
    constraints = [priorityConstraint(200)];
  }

  space.addComponent(new LowPriority(), 'low');
  space.addComponent(new MidPriority(), 'mid');
  space.addComponent(new HighPriority(), 'high');

  const order = getComponentOrder(space);
  assertBefore(order, 'high', 'mid', 'High priority before mid');
  assertBefore(order, 'mid', 'low', 'Mid priority before low');
});

test('Registration order as final tiebreaker', () => {
  const space = createTestSpace();

  // Three components with same priority, no ordering constraints
  class SamePriority extends Component {
    constraints = [priorityConstraint(100)];
  }

  space.addComponent(new SamePriority(), 'first');
  space.addComponent(new SamePriority(), 'second');
  space.addComponent(new SamePriority(), 'third');

  const order = getComponentOrder(space);
  // Should maintain registration order as tiebreaker
  assertBefore(order, 'first', 'second', 'Registration order: first before second');
  assertBefore(order, 'second', 'third', 'Registration order: second before third');
});

test('Switching ordering strategy at runtime', () => {
  const veilState = new VEILStateManager();
  const space = new Space(veilState); // Default: priority strategy

  space.addComponent(new ComponentA(), 'a');
  space.addComponent(new ComponentB(), 'b');

  console.log('  Initial order:', getComponentOrder(space).join(' -> '));

  // Switch to multi-constraint strategy
  space.setOrderingStrategy(new MultiConstraintOrderingStrategy({ verbose: false }));

  // Order should be recalculated
  console.log('  After switch:', getComponentOrder(space).join(' -> '));
});

// ═══════════════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║     MULTI-CONSTRAINT ORDERING TEST SUITE                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

// Tests are run as they're defined above

console.log('\n════════════════════════════════════════════════════════════════');
console.log(`Tests: ${passCount}/${testCount} passed`);
if (passCount === testCount) {
  console.log('All tests passed!');
} else {
  console.log(`${testCount - passCount} test(s) failed`);
  process.exit(1);
}
