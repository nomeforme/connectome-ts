#!/usr/bin/env tsx
/**
 * Box Dispenser - FLEX Architecture
 *
 * Demonstrates:
 * - Dynamic element creation via VEIL (boxes created on demand)
 * - Component-state management (no @persistent)
 * - Action handling in FLEX
 * - Effectors creating elements through events
 * - Full Host integration
 *
 * Architecture:
 * - DispenseButtonReceptor: button:press event → button-press facet (priority 100)
 * - DispenseEffector: Watches button-press, creates box (priority 300)
 * - BoxOpenReceptor: box:open event → activation facet (priority 100)
 * - All state in VEIL component-state facets
 */

import { config } from 'dotenv';
config();

import {
  ConnectomeHost,
  Space,
  VEILStateManager,
  Element,
  ConsoleAfferent,
  ConsoleMessageReceptor,
  ConsoleSpeechEffector,
  AgentEffector,
  BasicAgent,
  ContextTransform,
  ContinuationTransform,
  MockLLMProvider,
  ComponentRegistry,
  ElementRequestReceptor,
  ElementTreeMaintainer,
  createConsoleElement
} from '../src';
import { Component } from '../src/spaces/component';
import { ExecutionContext, SpaceEvent } from '../src/spaces/types';
import { ReadonlyVEILState, FacetDelta, FacetFilter } from '../src/spaces/component-types';
import { VEILDelta, Facet } from '../src/veil/types';
import { ConnectomeApplication } from '../src/host/types';
import { AfferentContext } from '../src/spaces/component-types';

// ============================================
// RECEPTORS (FLEX Components, priority 100)
// ============================================

/**
 * Converts button press events to facets
 */
class DispenseButtonReceptor extends Component {
  priority = 100;
  topics = ['button:press'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'button:press') return;

    console.log('[DispenseButton] Button pressed!');

    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `button-press-${Date.now()}`,
        type: 'event',
        content: '*CLICK* The button depresses with a satisfying mechanical sound.',
        state: {
          source: 'button',
          eventType: 'button-press'
        }
      }
    });
  }
}

/**
 * Converts box open events to facets + activation
 */
class BoxOpenReceptor extends Component {
  priority = 100;
  topics = ['box:open'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'box:open') return;

    const { boxId, method } = event.payload as any;
    console.log(`[BoxOpenReceptor] Processing box:open for box ${boxId}, method: ${method}`);

    // Create open event facet
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `box-${boxId}-opened-${Date.now()}`,
        type: 'event',
        content: `💥 The box opens ${method}!`,
        state: {
          source: 'box',
          eventType: 'box-opened'
        },
        attributes: { boxId, method }
      }
    });

    // Create activation for agent to react
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `activation-box-open-${Date.now()}`,
        type: 'agent-activation',
        content: `Box opened ${method}`,
        state: {
          source: 'box',
          reason: `box_opened_${method}`,
          priority: 'high',
          boxId
        },
        ephemeral: true
      }
    });
  }
}

/**
 * Parses console commands for dispenser actions
 */
class DispenserCommandReceptor extends Component {
  priority = 100;
  topics = ['console:message'];

  execute(context: ExecutionContext): void {
    const { event } = context;
    if (!event || event.topic !== 'console:message') return;

    const payload = event.payload as any;
    const content = payload.content?.toLowerCase() || '';

    // Don't override the default console message handling, just add command interpretation
    // Only process if it matches our commands
    if (content.includes('press') && content.includes('button')) {
      console.log('[DispenserCommand] Detected button press command');
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `command-press-${Date.now()}`,
          type: 'event',
          content: 'User wants to press the button',
          state: {
            source: 'console',
            eventType: 'command-button-press'
          }
        }
      });
      return;
    }

    const openMatch = content.match(/open\s+box[-\s]*(\d+)/i);
    if (openMatch) {
      const boxNum = openMatch[1];
      console.log(`[DispenserCommand] Detected open box-${boxNum} command`);
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `command-open-${Date.now()}`,
          type: 'event',
          content: `User wants to open box-${boxNum}`,
          state: {
            source: 'console',
            eventType: 'command-box-open'
          },
          attributes: { boxId: boxNum }
        }
      });
    }
  }
}

/**
 * Executes dispenser commands (FLEX Effector, priority 300)
 */
class DispenserCommandEffector extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    // Build changes from frame deltas
    const changes = this.buildChangesFromDeltas(frame.deltas, state);

    for (const change of changes) {
      if (change.type !== 'added') continue;

      const eventType = (change.facet as any).state?.eventType;

      if (eventType === 'command-button-press') {
        // Emit button press event
        this.addEvent({
          topic: 'button:press',
          source: { elementId: 'dispenser', elementPath: [], elementType: 'Element' },
          timestamp: Date.now(),
          payload: {}
        });
      }

      if (eventType === 'command-box-open') {
        const boxId = (change.facet as any).attributes?.boxId;
        console.log(`[DispenserCommandEffector] Emitting box:open for box ${boxId}`);
        if (boxId) {
          // Emit box open event
          this.addEvent({
            topic: 'box:open',
            source: { elementId: `box-${boxId}`, elementPath: [], elementType: 'Element' },
            timestamp: Date.now(),
            payload: { boxId, method: 'carefully' }
          });
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

// ============================================
// TRANSFORMS
// ============================================

/**
 * Applies StateChangeFacets to actual state facets (FLEX Transform, priority 200)
 * This is the proper FLEX pattern: Effectors emit state-change facets,
 * Transforms apply them to actual state
 */
class BoxStateTransform extends Component {
  priority = 200;

  execute(context: ExecutionContext): void {
    const { state } = context;

    for (const [id, facet] of state.facets) {
      if (facet.type === 'state-change' && (facet as any).targetFacetIds) {
        const stateChange = facet as any;
        console.log(`[BoxStateTransform] Processing state-change for targets:`, stateChange.targetFacetIds);

        // Apply changes to each target facet
        for (const targetId of stateChange.targetFacetIds) {
          const targetFacet = state.facets.get(targetId);
          if (!targetFacet) continue;

          // Build the changes to apply
          const changes: any = {};

          if (stateChange.state?.changes?.content?.new) {
            changes.content = stateChange.state.changes.content.new;
          }

          if (stateChange.state?.changes?.isOpen?.new !== undefined) {
            changes.state = {
              ...(targetFacet as any).state,
              isOpen: stateChange.state.changes.isOpen.new
            };
          }

          if (Object.keys(changes).length > 0) {
            this.addOperation({
              type: 'rewriteFacet',  // Exotemporal: applying the state change
              id: targetId,
              changes
            });
          }
        }

        // Remove the state-change facet after processing (it's ephemeral)
        this.addOperation({
          type: 'removeFacet',
          id
        });
      }
    }
  }
}

// ============================================
// EFFECTORS
// ============================================

/**
 * Dispenses boxes when button is pressed (FLEX Effector, priority 300)
 */
class DispenseEffector extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];

  execute(context: ExecutionContext): void {
    const { frame, state } = context;
    if (!frame) return;

    // Build changes from frame deltas
    const changes = this.buildChangesFromDeltas(frame.deltas, state);

    for (const change of changes) {
      if (change.type !== 'added') continue;

      const eventType = (change.facet as any).state?.eventType;
      if (eventType !== 'button-press') continue;

      // Get dispenser state from VEIL
      const dispenserState = this.getComponentState<{ boxCount: number; size: string; color: string }>();
      const boxCount = (dispenserState.boxCount || 0) + 1;
      const size = dispenserState.size || 'medium';
      const color = dispenserState.color || 'blue';

      console.log(`[DispenseEffector] Dispensing box #${boxCount} (${size}, ${color})`);

      // Update dispenser state
      this.updateComponentState({ boxCount, lastDispensed: Date.now() });

      // Create box element via VEIL with continuation tag
      this.addEvent({
        topic: 'element:create',
        source: { elementId: this.element?.id || 'dispenser', elementPath: [], elementType: 'Element' },
        timestamp: Date.now(),
        payload: {
          parentId: 'root',  // Add to space root
          name: `box-${boxCount}`,
          elementType: 'Box',
          components: [{
            type: 'BoxComponent',
            componentClass: 'effector',
            config: {
              boxId: boxCount,
              size,
              color,
              contents: `Mystery item #${boxCount}`,
              isOpen: false
            }
          }],
          // Add continuation to trigger agent activation after box creation
          continuations: [{
            facetType: 'agent-activation',
            facetSpec: {
              id: `activation-dispense-box-${boxCount}`,
              content: `New ${size} ${color} box #${boxCount} dispensed`,
              state: {
                source: 'dispenser',
                reason: 'box_dispensed',
                priority: 'normal',
                boxId: boxCount,
                boxElementId: '{{result.elementId}}'  // Filled by ContinuationTransform
              }
            },
            condition: 'success'
          }]
        }
      });

      // Agent activation will happen via continuation after box is created
      // No need to activate directly here
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
 * Handles box component behavior (FLEX Effector, priority 300)
 * This is actually more like a traditional component since boxes are interactive elements
 */
class BoxComponent extends Component {
  priority = 300;
  facetFilters: FacetFilter[] = [{ type: 'event' }];
  private initialized = false;

  // Declare actions for registration
  static actions = {
    open: {
      description: 'Open this box',
      parameters: {
        method: { type: 'string', enum: ['gently', 'forcefully', 'carefully'], required: false }
      }
    }
  };

  async onMount(): Promise<void> {
    // Register action handler
    (this as any).actions = new Map();
    (this as any).actions.set('open', this.open.bind(this));

    // Initialize box state (FLEX components initialize in onMount via events)
    const config = this.getComponentState<{
      boxId: number;
      size: string;
      color: string;
      contents: string;
      isOpen: boolean;
    }>();

    console.log(`[Box ${config.boxId}] Initialized: ${config.size} ${config.color} box`);

    // Create initial box state facet
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `${this.element?.id}-state`,
        type: 'state',
        content: `A ${config.size} ${config.color} box sits here, closed and mysterious.`,
        entityType: 'element',
        entityId: this.element?.id,
        state: config
      }
    });

    // Add action hint
    this.addOperation({
      type: 'addFacet',
      facet: {
        id: `${this.element?.id}-hint`,
        type: 'ambient',
        content: `You can open this box with @${this.element?.id}.open()`
      }
    });

    this.initialized = true;
  }

  execute(context: ExecutionContext): void {
    if (!this.initialized) return;

    const { frame, state } = context;
    if (!frame) return;

    // Build changes from frame deltas
    const changes = this.buildChangesFromDeltas(frame.deltas, state);

    // Boxes process open events to update their own state
    for (const change of changes) {
      if (change.type !== 'added') continue;

      const eventType = (change.facet as any).state?.eventType;
      const boxId = (change.facet as any).attributes?.boxId;
      const myBoxId = this.getComponentState().boxId;

      if (eventType === 'box-opened' && boxId == myBoxId) {
        // Update our component-state to mark as open (scoped write, immediate)
        const config = this.getComponentState();
        this.updateComponentState({ isOpen: true });

        // Emit StateChangeFacet for the endotemporal evolution
        // This records that the state changed at this moment in time
        const openEffect = this.getOpeningEffect(config.color);
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `${this.element?.id}-state-change-${Date.now()}`,
            type: 'state-change',
            targetFacetIds: [`${this.element?.id}-state`],
            state: {
              changes: {
                isOpen: { old: false, new: true },
                content: {
                  old: `A ${config.size} ${config.color} box sits here, closed and mysterious.`,
                  new: `The ${config.size} ${config.color} box is open, revealing ${config.contents}!`
                }
              }
            },
            ephemeral: true
          }
        });

        // Emit event for the opening effect
        this.addOperation({
          type: 'addFacet',
          facet: {
            id: `box-open-effect-${Date.now()}`,
            type: 'event',
            content: `The box opens with a ${openEffect}!`,
            ephemeral: true
          }
        });
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

  private getOpeningEffect(color: string): string {
    switch (color) {
      case 'red': return 'burst of flame';
      case 'blue': return 'splash of water';
      case 'green': return 'shower of leaves';
      case 'rainbow': return 'cascade of rainbow sparkles';
      default: return 'puff of smoke';
    }
  }

  // Action handler
  async open(params?: { method?: string }): Promise<void> {
    const method = params?.method || 'normally';
    const config = this.getComponentState();

    if (config.isOpen) {
      this.addOperation({
        type: 'addFacet',
        facet: {
          id: `box-already-open-${Date.now()}`,
          type: 'event',
          content: 'The box is already open!',
          ephemeral: true
        }
      });
      return;
    }

    // Emit box open event
    this.addEvent({
      topic: 'box:open',
      source: { elementId: this.element?.id || 'box', elementPath: [], elementType: 'Element' },
      timestamp: Date.now(),
      payload: {
        boxId: config.boxId,
        method,
        contents: config.contents
      }
    });
  }
}

// ============================================
// APPLICATION
// ============================================

class DispenserApplication implements ConnectomeApplication {
  async createSpace(hostRegistry?: Map<string, any>): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry);
    return { space, veilState };
  }
  
  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🎮 Initializing Box Dispenser (FLEX)...\n');
    
    // Register components
    ComponentRegistry.register('ConsoleAfferent', ConsoleAfferent);
    ComponentRegistry.register('DispenseEffector', DispenseEffector);
    ComponentRegistry.register('BoxComponent', BoxComponent);
    
    // Add infrastructure
    space.addReceptor(new ElementRequestReceptor());
    space.addTransform(new ContinuationTransform());
    space.addTransform(new BoxStateTransform());  // Handles state-change facets
    space.addMaintainer(new ElementTreeMaintainer(space));
    
    // Add console
    space.addReceptor(new ConsoleMessageReceptor());
    
    // Create console via VEIL
    space.emit({
      topic: 'element:create',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {
        parentId: space.id,
        name: 'console',
        components: [{
          type: 'ConsoleAfferent',
          config: { streamId: 'console:main', prompt: '> ' }
        }]
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Initialize console
    const consoleElem = space.children.find(c => c.name === 'console');
    if (consoleElem) {
      const consoleAfferent = consoleElem.components[0] as ConsoleAfferent;
      const context: AfferentContext<any> = {
        config: { streamId: 'console:main', prompt: '> ' },
        afferentId: 'console-main',
        emit: (event) => space.emit(event),
        emitError: (error) => console.error('[Console Error]:', error)
      };
      
      await consoleAfferent.initialize(context);
      await consoleAfferent.start();
      
      space.addEffector(new ConsoleSpeechEffector(consoleAfferent));
    }
    
    // Add dispenser receptors and effectors
    space.addReceptor(new DispenseButtonReceptor());
    space.addReceptor(new BoxOpenReceptor());
    space.addReceptor(new DispenserCommandReceptor());
    space.addEffector(new DispenserCommandEffector());
    
    // Create dispenser element directly (for now - VEIL creation needs frame processing)
    const dispenserElem = new Element('dispenser');
    space.addChild(dispenserElem);
    
    const dispenseEffector = new DispenseEffector();
    await dispenserElem.addComponentAsync(dispenseEffector);
    
    // Initialize component-state manually (normally done by ElementTreeMaintainer)
    // This is temporary until we figure out VEIL-based creation during initialization
    const componentId = `${dispenserElem.id}:DispenseEffector:0`;
    space.emit({
      topic: 'veil:operation',
      source: dispenserElem.getRef(),
      timestamp: Date.now(),
      payload: {
        operation: {
          type: 'addFacet',
          facet: {
            id: `component-state:${componentId}`,
            type: 'component-state',
            componentType: 'DispenseEffector',
            componentClass: 'effector',
            componentId,
            elementId: dispenserElem.id,
            state: {
              boxCount: 0,
              size: 'medium',
              color: 'blue'
            }
          }
        }
      }
    });
    
    // Register as effector
    space.addEffector(dispenseEffector);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Create agent
    const agentElem = new Element('agent');
    space.addChild(agentElem);
    
    const llmProvider = (space as any).getReference?.('provider:llm.primary') || 
                        (space as any).getReference?.('llmProvider');
    
    const agent = new BasicAgent({
      config: {
        name: 'DispenserAgent',
        systemPrompt: `You are a whimsical AI assistant observing a magical box dispenser.
React with curiosity and wonder to boxes being created and opened.
Be playful and creative in your responses.`
      },
      provider: llmProvider,
      veilStateManager: veilState
    });
    
    space.addEffector(new AgentEffector(agentElem, agent));
    const contextTransform = new ContextTransform({});
    await contextTransform.mount(space);
    
    console.log('✅ Box Dispenser initialized\n');
    console.log('Commands:');
    console.log('  - Type "press button" to dispense a box');
    console.log('  - Type "open box-N" to open a specific box');
    console.log('  - Type "/quit" to exit\n');
  }
  
  getComponentRegistry(): typeof ComponentRegistry {
    return ComponentRegistry;
  }
  
  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Box Dispenser started!\n');
    
    // Dispense first box automatically
    console.log('🎁 Dispensing initial box...\n');
    space.emit({
      topic: 'button:press',
      source: space.getRef(),
      timestamp: Date.now(),
      payload: {}
    });
  }
}

async function main() {
  console.log('🎁 Box Dispenser - Pure FLEX Architecture');
  console.log('=========================================\n');
  
  const mockProvider = new MockLLMProvider();
  mockProvider.setResponses([
    "Ooh! A new box appears! I wonder what's inside?",
    "How exciting! The mystery box awaits...",
    "*Eyes widen* What treasures might this box hold?",
    "Another box! The anticipation is delightful!",
    "Wow! The contents are revealed! Fascinating!",
    "What a delightful surprise that was!",
    "I'm absolutely captivated by these mysterious boxes!"
  ]);
  
  const app = new DispenserApplication();
  
  const host = new ConnectomeHost({
    providers: {
      'llm.primary': mockProvider
    },
    persistence: {
      enabled: false  // Disable for demo
    },
    debug: {
      enabled: false
    },
    reset: true
  });
  
  const shutdown = async () => {
    console.log('\n\n👋 Shutting down...');
    await host.stop();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  try {
    await host.start(app);
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

main();
