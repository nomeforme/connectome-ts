/**
 * Example showing symbol-based type identification - FLEX Architecture
 * Much more reliable than duck typing!
 *
 * Note: FLEX uses priority-based component ordering, making type
 * identification less critical since all components extend Component.
 */

import {
  Space,
  Element,
  VEILStateManager
} from '../src';
import { Component } from '../src/spaces/component';
import { ExecutionContext, SpaceEvent } from '../src/spaces/types';
import {
  isEffector,
  isReceptor,
  isTransform,
  RETM_TYPE,
  RETM_TYPES
} from '../src/utils/retm-type-guards';
import { ReadonlyVEILState, FacetDelta, FacetFilter } from '../src/spaces/component-types';
import { VEILDelta, Facet } from '../src/veil/types';

// Example: FLEX Component with effector-like behavior (priority 300)
class ButtonEffector extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    console.log('Button effector processing changes');
    // Process changes via this.buildChangesFromDeltas(frame.deltas, state)
  }
}

// Custom FLEX component with receptor-like behavior (priority 100)
class CustomReceptor extends Component {
  priority = 100;
  topics = ['custom:event'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'custom:event') return;

    console.log('Custom receptor transforming event');
    // Add operations via this.addOperation()
  }

  // Component interface
  async onMount(): Promise<void> {
    console.log('Custom receptor mounted');
  }

  async onUnmount(): Promise<void> {
    console.log('Custom receptor unmounted');
  }
}

// FLEX component that handles multiple concerns via priority ordering
class HybridComponent extends Component {
  priority = 200; // Transform-like

  execute(context: ExecutionContext): void {
    const { state } = context;
    console.log('Hybrid component processing state');
    // Process state and emit operations
  }
}

// Test FLEX priority-based component ordering
function testFlexComponents() {
  const button = new ButtonEffector();
  const custom = new CustomReceptor();
  const hybrid = new HybridComponent();

  // In FLEX, components are ordered by priority, not type
  console.log('ButtonEffector priority:', button.priority); // 300 (effector-like)
  console.log('CustomReceptor priority:', custom.priority); // 100 (receptor-like)
  console.log('HybridComponent priority:', hybrid.priority); // 200 (transform-like)

  // All extend Component, so type guards are less relevant
  console.log('All are Components:', [button, custom, hybrid].every(c => c instanceof Component));
}

// FLEX discovery - components are collected and sorted by priority
async function demonstrateFlexDiscovery() {
  const veilState = new VEILStateManager();
  const space = new Space(veilState);

  // Create elements with FLEX components
  const buttonElement = new Element('button');
  space.addChild(buttonElement);
  buttonElement.addComponent(new ButtonEffector());

  const sensorElement = new Element('sensor');
  space.addChild(sensorElement);
  sensorElement.addComponent(new CustomReceptor());

  // In FLEX, components are discovered and sorted by priority
  const discoverComponents = () => {
    const components: Component[] = [];
    const traverse = (elem: Element) => {
      components.push(...(elem.components as Component[]));
      elem.children.forEach(traverse);
    };
    traverse(space);

    // Sort by priority for FLEX execution order
    components.sort((a, b) => a.priority - b.priority);

    console.log('Components by priority:');
    for (const comp of components) {
      const role = comp.priority <= 100 ? 'receptor'
        : comp.priority <= 200 ? 'transform'
        : comp.priority <= 300 ? 'effector'
        : 'maintainer';
      console.log(`  ${comp.constructor.name} (priority ${comp.priority}) - ${role}`);
    }
  };

  discoverComponents();
}

// Run the examples
console.log('=== FLEX Priority-Based Components ===');
testFlexComponents();

console.log('\n=== FLEX Discovery Demo ===');
demonstrateFlexDiscovery();
