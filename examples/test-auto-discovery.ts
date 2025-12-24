#!/usr/bin/env tsx
/**
 * Test auto-discovery - FLEX Architecture
 * Shows the dramatically simplified developer experience
 */

import { config } from 'dotenv';
config();

import {
  VEILStateManager,
  Element,
  Space,
  createEventFacet
} from '../src';
import { Component } from '../src/spaces/component';
import { ExecutionContext, SpaceEvent } from '../src/spaces/types';
import {
  ReadonlyVEILState,
  FacetDelta,
  FacetFilter,
  Frame
} from '../src/spaces/component-types';
import { VEILDelta, Facet } from '../src/veil/types';

/**
 * FLEX Receptor (priority 100) - handles UI clicks
 */
class ButtonReceptor extends Component {
  priority = 100;
  topics = ['ui:click'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'ui:click') return;

    console.log('🔘 Button clicked!');
    this.addOperation({
      type: 'addFacet',
      facet: createEventFacet({
        id: `button-press-${Date.now()}`,
        content: 'Button was pressed',
        source: 'button',
        eventType: 'button-press'
      })
    });
  }
}

/**
 * FLEX Effector (priority 300) - displays messages
 */
class DisplayEffector extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    const changes = this.buildChangesFromDeltas(frame.deltas, state);
    for (const change of changes) {
      if (change.type === 'added' && change.facet.type === 'event') {
        const event = change.facet as any;
        if (event.state?.eventType === 'button-press') {
          console.log('📺 Display showing: Button pressed!');
        }
      }
    }
  }

  private buildChangesFromDeltas(deltas: VEILDelta[], state: ReadonlyVEILState): FacetDelta[] {
    const changes: FacetDelta[] = [];
    for (const delta of deltas) {
      if (delta.type === 'addFacet' && this.matchesFacetFilters(delta.facet)) {
        changes.push({ type: 'added', facet: delta.facet });
      }
    }
    return changes;
  }

  private matchesFacetFilters(facet: Facet): boolean {
    if (!this.facetFilters || this.facetFilters.length === 0) return true;
    return this.facetFilters.some(filter => {
      if (filter.type && facet.type !== filter.type) return false;
      return true;
    });
  }
}

/**
 * FLEX Transform (priority 200) - tracks button presses
 */
class CounterTransform extends Component {
  priority = 200;
  private count = 0;

  execute(context: ExecutionContext): void {
    const { state } = context;

    // Count button presses
    for (const [id, facet] of state.facets) {
      if (facet.type === 'event' && (facet as any).state?.eventType === 'button-press') {
        this.count++;
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `counter-${Date.now()}`,
            type: 'state',
            content: `Button pressed ${this.count} times`,
            state: { count: this.count }
          }
        });
      }
    }
  }
}

/**
 * FLEX Maintainer (priority 400) - logs all events
 */
class EventLoggerMaintainer extends Component {
  priority = 400;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    const changes = this.buildChangesFromDeltas(frame.deltas, state);
    const eventCount = changes.filter(c =>
      c.type === 'added' && c.facet.type === 'event'
    ).length;

    if (eventCount > 0) {
      console.log(`📝 Logger: ${eventCount} events in frame ${frame.sequence}`);
    }
  }

  private buildChangesFromDeltas(deltas: VEILDelta[], state: ReadonlyVEILState): FacetDelta[] {
    const changes: FacetDelta[] = [];
    for (const delta of deltas) {
      if (delta.type === 'addFacet' && this.matchesFacetFilters(delta.facet)) {
        changes.push({ type: 'added', facet: delta.facet });
      }
    }
    return changes;
  }

  private matchesFacetFilters(facet: Facet): boolean {
    if (!this.facetFilters || this.facetFilters.length === 0) return true;
    return this.facetFilters.some(filter => {
      if (filter.type && facet.type !== filter.type) return false;
      return true;
    });
  }
}

async function testAutoDiscovery() {
  console.log('🚀 FLEX Auto-Discovery Test');
  console.log('============================\n');

  const veilState = new VEILStateManager();
  const space = new Space(veilState);

  // Create UI structure
  const ui = new Element('ui-root');
  space.addChild(ui);

  const button = new Element('button');
  ui.addChild(button);

  const display = new Element('display');
  ui.addChild(display);

  const system = new Element('system');
  space.addChild(system);

  console.log('✨ Adding FLEX components with priority-based ordering:\n');

  // Add components - in FLEX, they execute by priority order
  const buttonReceptor = new ButtonReceptor();
  button.addComponent(buttonReceptor);
  space.addReceptor(buttonReceptor);
  console.log('  ✓ ButtonReceptor (priority 100)');

  const displayEffector = new DisplayEffector();
  display.addComponent(displayEffector);
  space.addEffector(displayEffector);
  console.log('  ✓ DisplayEffector (priority 300)');

  const counterTransform = new CounterTransform();
  system.addComponent(counterTransform);
  space.addTransform(counterTransform);
  console.log('  ✓ CounterTransform (priority 200)');

  const eventLogger = new EventLoggerMaintainer();
  system.addComponent(eventLogger);
  space.addMaintainer(eventLogger);
  console.log('  ✓ EventLoggerMaintainer (priority 400)');

  console.log('\n🔍 FLEX executes components in priority order: 100 → 200 → 300 → 400\n');

  // Simulate button clicks
  console.log('--- Click 1 ---');
  space.emit({
    topic: 'ui:click',
    source: button.getRef(),
    timestamp: Date.now(),
    payload: { x: 100, y: 50 }
  });

  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\n--- Click 2 ---');
  space.emit({
    topic: 'ui:click',
    source: button.getRef(),
    timestamp: Date.now(),
    payload: { x: 100, y: 50 }
  });

  await new Promise(resolve => setTimeout(resolve, 100));

  // Add component dynamically
  console.log('\n🎯 Adding component dynamically...');
  const newButton = new Element('second-button');
  ui.addChild(newButton);
  const newButtonReceptor = new ButtonReceptor();
  newButton.addComponent(newButtonReceptor);
  space.addReceptor(newButtonReceptor);
  console.log('  ✓ Dynamically added second button');

  console.log('\n--- Click 3 (from new button) ---');
  space.emit({
    topic: 'ui:click',
    source: newButton.getRef(),
    timestamp: Date.now(),
    payload: { x: 200, y: 100 }
  });

  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\n✅ FLEX Benefits demonstrated:');
  console.log('  • All components extend Component');
  console.log('  • Priority determines execution order');
  console.log('  • Dynamic component addition supported');
  console.log('  • Simple, predictable execution flow');
  console.log('  • State updates visible to later components!');
}

testAutoDiscovery().catch(console.error);
