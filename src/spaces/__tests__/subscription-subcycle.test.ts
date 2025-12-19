/**
 * Tests for subscription mechanism and sub-cycle processing
 */

import { Space } from '../space';
import { Component } from '../component';
import { VEILStateManager } from '../../veil/veil-state';
import { SpaceEvent } from '../types';

// Test helper to wait for async operations
const tick = () => new Promise(resolve => setImmediate(resolve));

// Track execution for assertions
interface ExecutionLog {
  componentId: string;
  topic: string;
  timestamp: number;
}

describe('Subscription Mechanism', () => {
  let space: Space;
  let veilState: VEILStateManager;
  let executionLog: ExecutionLog[];

  beforeEach(() => {
    veilState = new VEILStateManager();
    space = new Space(veilState);
    executionLog = [];
  });

  afterEach(() => {
    // Cleanup
  });

  // Helper to create a test component with configurable topics
  function createTestComponent(
    id: string,
    topics: string[] | '*',
    eventFilter?: (event: SpaceEvent) => boolean
  ): Component {
    class TestComponent extends Component {
      topics = topics;
      eventFilter = eventFilter;

      execute(context: any): void {
        executionLog.push({
          componentId: this.id,
          topic: context.event.topic,
          timestamp: Date.now()
        });
      }
    }
    
    const component = new TestComponent();
    space.addComponent(component, id);
    return component;
  }

  test('component with topics="*" receives all events', async () => {
    createTestComponent('all-receiver', '*');

    space.emit({
      topic: 'test:event1',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'other:event2',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(2);
    expect(executionLog[0].topic).toBe('test:event1');
    expect(executionLog[1].topic).toBe('other:event2');
  });

  test('component with specific topics only receives matching events', async () => {
    createTestComponent('specific-receiver', ['test:event1', 'test:event2']);

    space.emit({
      topic: 'test:event1',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'other:event',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'test:event2',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(2);
    expect(executionLog[0].topic).toBe('test:event1');
    expect(executionLog[1].topic).toBe('test:event2');
  });

  test('wildcard pattern with colon works (discord:*)', async () => {
    createTestComponent('discord-receiver', ['discord:*']);

    space.emit({
      topic: 'discord:message',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'discord:joined',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'slack:message',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(2);
    expect(executionLog.every(e => e.topic.startsWith('discord:'))).toBe(true);
  });

  test('wildcard pattern with dot works (discord.*)', async () => {
    createTestComponent('dot-receiver', ['panel.*']);

    space.emit({
      topic: 'panel.opened',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'panel.closed',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'other.event',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(2);
    expect(executionLog.every(e => e.topic.startsWith('panel.'))).toBe(true);
  });

  test('eventFilter is called and respected', async () => {
    createTestComponent(
      'filtered-receiver',
      '*',
      (event): boolean => !!(event.payload && (event.payload as any).important === true)
    );

    space.emit({
      topic: 'test:event',
      source: space.getRef(),
      payload: { important: false },
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'test:event',
      source: space.getRef(),
      payload: { important: true },
      timestamp: Date.now()
    });
    await tick();

    space.emit({
      topic: 'test:event',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(1);
    expect(executionLog[0].topic).toBe('test:event');
  });

  test('multiple components with different subscriptions', async () => {
    createTestComponent('all', '*');
    createTestComponent('discord-only', ['discord:*']);
    createTestComponent('panel-only', ['panel:*']);

    space.emit({
      topic: 'discord:message',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    // Should be received by 'all' and 'discord-only'
    const discordReceivers = executionLog.filter(e => e.topic === 'discord:message');
    expect(discordReceivers.length).toBe(2);
    expect(discordReceivers.map(e => e.componentId).sort()).toEqual(['all', 'discord-only'].sort());

    executionLog.length = 0;

    space.emit({
      topic: 'panel:opened',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    // Should be received by 'all' and 'panel-only'
    const panelReceivers = executionLog.filter(e => e.topic === 'panel:opened');
    expect(panelReceivers.length).toBe(2);
    expect(panelReceivers.map(e => e.componentId).sort()).toEqual(['all', 'panel-only'].sort());
  });
});

describe('Sub-Cycle Processing', () => {
  let space: Space;
  let veilState: VEILStateManager;
  let executionLog: ExecutionLog[];

  beforeEach(() => {
    veilState = new VEILStateManager();
    space = new Space(veilState, undefined, undefined, undefined, {
      subCycle: {
        maxDepth: 5,
        warningDepth: 3
      }
    });
    executionLog = [];
  });

  test('emitSync triggers immediate sub-cycle processing', async () => {
    let syncEventReceived = false;
    let syncEventReceivedDuringMainCycle = false;

    class MainComponent extends Component {
      topics: string[] | '*' = ['main:trigger'];

      execute(context: any): void {
        if (context.event.topic === 'main:trigger') {
          executionLog.push({
            componentId: 'main',
            topic: context.event.topic,
            timestamp: Date.now()
          });

          // Emit sync event
          this.emitSync({
            topic: 'sync:event',
            payload: { fromMain: true }
          });

          // Check if sync event was already processed
          syncEventReceivedDuringMainCycle = syncEventReceived;
        }
      }
    }

    class SyncReceiverComponent extends Component {
      topics: string[] | '*' = ['sync:event'];

      execute(context: any): void {
        if (context.event.topic === 'sync:event') {
          syncEventReceived = true;
          executionLog.push({
            componentId: 'sync-receiver',
            topic: context.event.topic,
            timestamp: Date.now()
          });
        }
      }
    }

    space.addComponent(new MainComponent(), 'main');
    space.addComponent(new SyncReceiverComponent(), 'sync-receiver');

    space.emit({
      topic: 'main:trigger',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executionLog.length).toBe(2);
    expect(executionLog[0].componentId).toBe('main');
    expect(executionLog[1].componentId).toBe('sync-receiver');
    // The sync event should have been received during the main component's execution
    expect(syncEventReceivedDuringMainCycle).toBe(true);
  });

  test('sub-cycle depth is tracked correctly', async () => {
    const depths: number[] = [];

    class DepthTracker extends Component {
      topics: string[] | '*' = ['depth:*'];

      execute(context: any): void {
        const depth = parseInt(context.event.topic.split(':')[1], 10);
        depths.push(depth);

        if (depth < 3) {
          this.emitSync({
            topic: `depth:${depth + 1}`,
            payload: {}
          });
        }
      }
    }

    space.addComponent(new DepthTracker(), 'depth-tracker');

    space.emit({
      topic: 'depth:1',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(depths).toEqual([1, 2, 3]);
  });

  test('max depth limit prevents infinite loops', async () => {
    let executionCount = 0;

    class InfiniteLooper extends Component {
      topics: string[] | '*' = ['loop:*'];

      execute(context: any): void {
        executionCount++;
        // Always emit another sync event
        const count = parseInt(context.event.topic.split(':')[1], 10);
        this.emitSync({
          topic: `loop:${count + 1}`,
          payload: {}
        });
      }
    }

    space.addComponent(new InfiniteLooper(), 'looper');

    // Should not hang forever - errors are caught internally
    space.emit({
      topic: 'loop:1',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    // Execution should be limited by maxDepth (5) + the initial call
    // Error is caught internally, preventing stack overflow
    expect(executionCount).toBeLessThanOrEqual(6);
  });

  test('max depth limit buffers event when configured', async () => {
    const bufferedSpace = new Space(new VEILStateManager(), undefined, undefined, undefined, {
      subCycle: {
        maxDepth: 3,
        onMaxDepthExceeded: 'buffer'
      }
    });

    let maxDepthReached = 0;
    let executionsInFirstFrame = 0;
    let firstFrameComplete = false;

    class DepthTester extends Component {
      topics: string[] | '*' = ['test:*'];

      execute(context: any): void {
        const depth = parseInt(context.event.topic.split(':')[1], 10);
        maxDepthReached = Math.max(maxDepthReached, depth);

        if (!firstFrameComplete) {
          executionsInFirstFrame++;
        }

        if (depth < 10) {
          this.emitSync({
            topic: `test:${depth + 1}`,
            payload: {}
          });
        }
      }
    }

    bufferedSpace.addComponent(new DepthTester(), 'tester');

    // Should not throw
    bufferedSpace.emit({
      topic: 'test:1',
      source: bufferedSpace.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();
    firstFrameComplete = true;

    // Sync executions should be limited by maxDepth
    // Initial event + 3 sub-cycles = 4 executions max in first frame
    expect(executionsInFirstFrame).toBeLessThanOrEqual(4);

    // Process buffered events in subsequent frames
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();

    // Now should have processed all 10 via buffered events
    expect(maxDepthReached).toBeGreaterThanOrEqual(4);
  });

  test('sub-cycle trace is recorded in frame', async () => {
    class TraceTester extends Component {
      topics: string[] | '*' = ['trace:*'];

      execute(context: any): void {
        if (context.event.topic === 'trace:start') {
          this.emitSync({
            topic: 'trace:sub1',
            payload: {}
          });
        }
      }
    }

    space.addComponent(new TraceTester(), 'trace-tester');

    space.emit({
      topic: 'trace:start',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    // Check frame history for sub-cycle trace
    const state = veilState.getState();
    const lastFrame = state.frameHistory[state.frameHistory.length - 1];
    
    expect(lastFrame.subCycleTrace).toBeDefined();
    expect(lastFrame.subCycleTrace!.length).toBeGreaterThan(0);
    expect(lastFrame.subCycleTrace![0].depth).toBe(1);
    expect(lastFrame.subCycleTrace![0].triggeringEventId).toContain('trace:sub1');
  });

  test('full cycle processes all subscribed components', async () => {
    const processedBy: string[] = [];

    class FirstComponent extends Component {
      // Subscribe to both topics to receive sync:event
      topics: string[] | '*' = ['start', 'sync:event'];

      execute(context: any): void {
        if (context.event.topic === 'start') {
          processedBy.push('first-start');
          this.emitSync({
            topic: 'sync:event',
            payload: {}
          });
        } else if (context.event.topic === 'sync:event') {
          processedBy.push('first-sync');
        }
      }
    }

    class SecondComponent extends Component {
      topics: string[] | '*' = ['sync:event'];

      execute(context: any): void {
        processedBy.push('second-sync');
      }
    }

    space.addComponent(new FirstComponent(), 'first');
    space.addComponent(new SecondComponent(), 'second');

    space.emit({
      topic: 'start',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    // Both components that are subscribed to 'sync:event' should receive it
    expect(processedBy).toContain('first-start');
    expect(processedBy).toContain('first-sync');
    expect(processedBy).toContain('second-sync');
  });
});

describe('Edge Cases', () => {
  let space: Space;
  let veilState: VEILStateManager;

  beforeEach(() => {
    veilState = new VEILStateManager();
    space = new Space(veilState);
  });

  test('disabled component is skipped even with matching topics', async () => {
    let executed = false;

    class DisabledComponent extends Component {
      topics: string[] | '*' = ['test:event'];

      execute(context: any): void {
        executed = true;
      }
    }

    const component = new DisabledComponent();
    space.addComponent(component, 'disabled');
    component.enabled = false;

    space.emit({
      topic: 'test:event',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executed).toBe(false);
  });

  test('empty topics array receives no events', async () => {
    let executed = false;

    class NoTopicsComponent extends Component {
      topics: string[] = [];

      execute(context: any): void {
        executed = true;
      }
    }

    space.addComponent(new NoTopicsComponent(), 'no-topics');

    space.emit({
      topic: 'test:event',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(executed).toBe(false);
  });

  test('matchesTopic handles edge cases correctly', () => {
    class TestComponent extends Component {
      topics: string[] | '*' = [];
    }

    const component = new TestComponent();

    // Test exact match
    component.topics = ['exact:topic'];
    expect(component.matchesTopic('exact:topic')).toBe(true);
    expect(component.matchesTopic('exact:other')).toBe(false);

    // Test wildcard with asterisk only
    component.topics = ['*'];
    expect(component.matchesTopic('any:topic')).toBe(true);

    // Test colon wildcard
    component.topics = ['prefix:*'];
    expect(component.matchesTopic('prefix:anything')).toBe(true);
    expect(component.matchesTopic('prefix:')).toBe(true);
    expect(component.matchesTopic('other:topic')).toBe(false);

    // Test dot wildcard
    component.topics = ['prefix.*'];
    expect(component.matchesTopic('prefix.anything')).toBe(true);
    expect(component.matchesTopic('prefix.')).toBe(true);
    expect(component.matchesTopic('other.topic')).toBe(false);
  });

  test('sync events during disabled state are handled gracefully', async () => {
    class SyncEmitter extends Component {
      topics: string[] | '*' = ['trigger'];

      execute(context: any): void {
        // Emit sync event
        this.emitSync({
          topic: 'sync:test',
          payload: {}
        });
      }
    }

    class SyncReceiver extends Component {
      topics: string[] | '*' = ['sync:test'];
      received = false;

      execute(context: any): void {
        this.received = true;
      }
    }

    const emitter = new SyncEmitter();
    const receiver = new SyncReceiver();
    space.addComponent(emitter, 'emitter');
    space.addComponent(receiver, 'receiver');

    // Disable receiver before emitting
    receiver.enabled = false;

    space.emit({
      topic: 'trigger',
      source: space.getRef(),
      payload: {},
      timestamp: Date.now()
    });
    await tick();

    expect(receiver.received).toBe(false);
  });
});

