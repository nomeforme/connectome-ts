/**
 * Example showing FLEX architecture - priority-based component execution
 * Components extend Component and specify their execution priority
 */

import { Space, Element, VEILStateManager } from '../src';
import { Component } from '../src/spaces/component';
import { ExecutionContext, SpaceEvent } from '../src/spaces/types';
import { ReadonlyVEILState, FacetDelta, FacetFilter } from '../src/spaces/component-types';
import { VEILDelta, Facet } from '../src/veil/types';

/**
 * FLEX Architecture Overview:
 *
 * All components extend Component with explicit priority values:
 * - 0-99: Modulators (preprocess events)
 * - 100-199: Receptors (convert events to facets)
 * - 200-299: Transforms (process VEIL state)
 * - 300-399: Effectors (execute side effects)
 * - 400+: Maintainers (cleanup, persistence)
 *
 * Components execute in priority order, with state updates
 * visible to later components within the same frame.
 */

// Example FLEX receptor (priority 100)
class ButtonPressReceptor extends Component {
  priority = 100;
  topics = ['button:press'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'button:press') return;

    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `button-press-${Date.now()}`,
        type: 'event',
        content: 'Button was pressed'
      }
    });
  }
}

// Example FLEX transform (priority 200)
class FeatureTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;
    // Process state and emit operations
    for (const [id, facet] of state.facets) {
      if (facet.type === 'event') {
        // Transform facets as needed
      }
    }
  }
}

// Example FLEX effector (priority 300)
class DispenseEffector extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    // Build changes from frame deltas
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet.type === 'event') {
        // Process event facets and emit events
        this.addEvent({
          topic: 'element:create',
          source: { elementId: this.element?.id || 'dispenser', elementPath: [], elementType: 'Element' },
          timestamp: Date.now(),
          payload: { name: 'new-element' }
        });
      }
    }
  }
}

// Usage - simple and clear
async function createBoxDispenser() {
  const veilState = new VEILStateManager();
  const space = new Space(veilState);

  // Create element
  const dispenserElement = new Element('dispenser');
  space.addChild(dispenserElement);

  // Add FLEX component with explicit registration
  const dispenseEffector = new DispenseEffector();
  dispenserElement.addComponent(dispenseEffector);
  space.addEffector(dispenseEffector);

  // Create button receptor
  const buttonElement = new Element('button');
  dispenserElement.addChild(buttonElement);

  const buttonReceptor = new ButtonPressReceptor();
  buttonElement.addComponent(buttonReceptor);
  space.addReceptor(buttonReceptor);

  // FLEX executes components in priority order:
  // 1. ButtonPressReceptor (100) - converts events to facets
  // 2. DispenseEffector (300) - processes facets and emits events
}

// Dynamic component addition works the same way
async function addNewFeature(space: Space) {
  const featureElement = new Element('new-feature');
  space.addChild(featureElement);

  // Add transform component
  const transform = new FeatureTransform();
  featureElement.addComponent(transform);
  space.addTransform(transform);

  // Add effector component
  const effector = new DispenseEffector();
  featureElement.addComponent(effector);
  space.addEffector(effector);
}

// Benefits of FLEX:
// 1. Simple priority-based execution model
// 2. All components extend Component
// 3. State updates visible to later components in same frame
// 4. Clear, predictable execution order
// 5. Easy to debug and understand
