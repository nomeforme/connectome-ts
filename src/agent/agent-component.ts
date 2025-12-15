/**
 * AgentComponent - FLEX component that manages agent lifecycle and executes agent cycles
 *
 * Consolidates the previous AgentComponent (container/lifecycle) and AgentEffector (execution)
 * into a single FLEX component with constraint: priority 300 (Effector level).
 *
 * Watches for agent-activation + rendered-context facets and runs the agent to produce
 * speech/action/thought facets.
 */

import { Component } from '../spaces/component';
import { SpaceEvent, ExecutionContext } from '../spaces/types';
import { AgentInterface, AgentCommand, AgentConfig, AgentState } from './types';
import {
  Facet,
  AgentLifecycleFacet,
  StreamRef,
  hasStateAspect,
  hasAgentGeneratedAspect,
  hasContentAspect,
  hasStreamAspect
} from '../veil/types';
import { persistable, persistent } from '../persistence/decorators';
import { reference, RestorableComponent } from '../host/decorators';
import { LLMProvider } from '../llm/llm-interface';
import { VEILStateManager } from '../veil/veil-state';
import { BasicAgent } from './basic-agent';
import { FacetDelta, ReadonlyVEILState, FacetFilter } from '../spaces/receptor-effector-types';
import { getGlobalTracer, TraceStorage } from '../tracing';
import { RenderedContext } from '../hud/types-v2';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';

@persistable(1)
export class AgentComponent extends Component implements RestorableComponent {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  // Watch for activation facets and rendered contexts
  // (action-result handling moved to ActionResultProcessor at MAINTAINER priority)
  facetFilters: FacetFilter[] = [
    { type: 'agent-activation' },
    { type: 'rendered-context' }
  ];

  private agent?: AgentInterface;
  private agentRegistered = false;
  private processingActivations = new Set<string>();
  private tracer?: TraceStorage;

  // Persist the agent configuration
  @persistent() private agentConfig?: AgentConfig;

  // References that will be injected by the Host
  @reference('veilState') private veilState?: VEILStateManager;
  @reference('llmProvider') private llmProvider?: LLMProvider;

  constructor(agentOrConfig?: AgentInterface | { agentConfig: AgentConfig }) {
    super();

    // Handle both direct agent and config object (from declarative creation)
    if (agentOrConfig) {
      // Check if it's a config wrapper (from declarative component:add)
      if ('agentConfig' in agentOrConfig && !('runCycle' in agentOrConfig)) {
        // It's a config object, store the agent config
        this.agentConfig = (agentOrConfig as { agentConfig: AgentConfig }).agentConfig;
      } else {
        // It's an actual agent object
        this.agent = agentOrConfig as AgentInterface;
        // Save agent config for restoration
        if ('config' in agentOrConfig) {
          this.agentConfig = (agentOrConfig as any).config;
        }
      }
    }
  }

  get agentInstance(): AgentInterface | undefined {
    return this.agent;
  }

  setAgent(agent: AgentInterface) {
    this.agent = agent;
    // Save agent config for restoration
    if ('config' in agent) {
      this.agentConfig = (agent as any).config;
    }
  }

  /**
   * Called by Host after all references are resolved
   */
  async onReferencesResolved(): Promise<void> {
    // If we have config but no agent, recreate it
    if (this.agentConfig && !this.agent && this.llmProvider && this.veilState) {
      // Check if there's a custom agent factory registered
      const space = this.space;
      const agentFactory = (space as any)?.getReference?.('agentFactory');

      if (agentFactory && typeof agentFactory === 'function') {
        // Use custom factory
        this.agent = agentFactory(this.agentConfig, this.llmProvider, this.veilState);
      } else {
        // Default to BasicAgent
        this.agent = new BasicAgent(this.agentConfig, this.llmProvider, this.veilState);
      }

      // Re-enable auto action registration if it was enabled
      if ((this.agentConfig as any).autoActionRegistration) {
        (this.agent as BasicAgent).enableAutoActionRegistration();
      }
    }
  }

  onMount(): void {
    this.tracer = getGlobalTracer();

    // Subscribe to agent commands
    this.subscribe('agent:command');
  }

  onFirstFrame(): void {
    // Register agent on first frame if we have everything we need
    if (!this.agentRegistered && this.agent && this.veilState) {
      this.registerAgent();
    }
    // Note: System prompt emission is the responsibility of application-level components
    // (e.g. DiscordInfrastructureTransform) which should emit ambient facets as needed.
    // This keeps the framework layer agnostic about how system prompts are configured.
  }

  onUnmount(): void {
    // Unregister agent from VEIL state
    if (this.veilState) {
      this.addOperation({
        type: 'addFacet',
        facet: this.createAgentLifecycleFacet('deregister')
      });
    }
  }

  /**
   * FLEX execute method - processes frame context for agent activations
   */
  execute(context: ExecutionContext): void {
    const { state, frame } = context;

    // Register agent if not yet done (backup for onFirstFrame)
    if (!this.agentRegistered && this.agent && this.veilState) {
      this.registerAgent();
    }

    // Build changes from frame deltas
    const changes: FacetDelta[] = [];
    if (frame && frame.deltas) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet') {
          changes.push({ type: 'added', facet: delta.facet });
        }
      }
    }

    if (changes.length === 0) return;

    // Process asynchronously (fire and forget for effector pattern)
    this.processActivations(changes, state);
  }

  /**
   * Handle events (for agent commands)
   */
  async handleEvent(event: SpaceEvent): Promise<void> {
    await super.handleEvent(event);

    if (event.topic === 'agent:command' && this.agent) {
      this.handleAgentCommand(event.payload as AgentCommand);
    }
  }

  /**
   * Process facet changes - look for activations with rendered contexts
   */
  private async processActivations(changes: FacetDelta[], state: ReadonlyVEILState): Promise<void> {
    if (!this.agent) return;

    for (const change of changes) {
      if (change.type !== 'added') continue;

      if (change.facet.type === 'agent-activation') {
        const activationId = change.facet.id;
        const activationState = hasStateAspect(change.facet)
          ? (change.facet.state as Record<string, any>)
          : {};

        if (this.processingActivations.has(activationId)) continue;

        // Check if this activation targets this agent
        const targetAgentId = activationState.targetAgentId as string | undefined;
        const targetAgent = activationState.targetAgent ?? activationState.targetAgentName;
        const agentName = this.agentConfig?.name || this.id;

        // Skip if targeted to a different agent
        if (targetAgentId && targetAgentId !== this.id) continue;
        if (targetAgent && targetAgent !== this.id && targetAgent !== agentName) continue;

        const flattenedActivation = {
          ...activationState,
          ...(activationState.metadata || {})
        };

        const veilState = state as any;
        if (!this.agent.shouldActivate(flattenedActivation, veilState)) {
          continue;
        }

        // Look for corresponding rendered context
        const contextFacet = Array.from(state.facets.values()).find(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === activationId
        );

        if (!contextFacet || !hasStateAspect(contextFacet)) {
          continue;
        }

        this.processingActivations.add(activationId);

        const streamRef = flattenedActivation.streamRef as StreamRef | undefined;
        const streamId = streamRef?.streamId ?? (flattenedActivation.streamId as string | undefined) ?? 'default';

        const contextState = contextFacet.state as { context: RenderedContext };
        const context = contextState.context;

        this.runAgentCycleBackground(context, streamRef, activationId, streamId);
      }
      // Note: action-result handling moved to ActionResultProcessor (MAINTAINER priority)
    }
  }

  /**
   * Runs the agent cycle in the background (fire-and-forget).
   * Emits response events when complete, allowing the current frame to finish immediately.
   */
  private runAgentCycleBackground(
    context: RenderedContext,
    streamRef: StreamRef | undefined,
    activationId: string,
    streamId: string
  ): void {
    (async () => {
      try {
        const response = await this.runAgentCycle(context, streamRef, activationId);

        // Emit events first (they may trigger actions)
        for (const event of response.events) {
          this.emit(event);
        }

        // Then emit facets for response
        for (const facet of response.facets) {
          this.emit({
            topic: 'veil:operation',
            timestamp: Date.now(),
            payload: {
              operation: {
                type: 'addFacet',
                facet
              }
            }
          });
        }

      } catch (error) {
        console.error('[AgentComponent] Agent cycle error:', error);

        // Emit error event
        this.emit({
          topic: 'veil:operation',
          timestamp: Date.now(),
          payload: {
            operation: {
              type: 'addFacet',
              facet: {
                id: `agent-error-${Date.now()}`,
                type: 'event',
                content: String(error),
                state: {
                  source: this.id,
                  eventType: 'agent-cycle-error',
                  metadata: { activationId }
                },
                streamId: streamId
              }
            }
          }
        });
      } finally {
        this.processingActivations.delete(activationId);
      }
    })();
  }

  private async runAgentCycle(
    context: RenderedContext,
    streamRef?: StreamRef,
    activationId?: string
  ): Promise<{ facets: Facet[]; events: SpaceEvent[] }> {
    const facets: Facet[] = [];

    if (!this.agent) {
      console.error('[AgentComponent] Agent not available for runCycle');
      return { facets: [], events: [] };
    }

    // Run the agent's cycle with the full context
    const outgoingFrame = await this.agent.runCycle(context, streamRef);

    // Convert agent operations to facets
    for (const operation of outgoingFrame.deltas) {
      if (operation.type === 'addFacet') {
        const preparedFacet = this.prepareAgentFacet(operation.facet, streamRef);
        facets.push(preparedFacet);
      }
    }

    return { facets, events: outgoingFrame.events || [] };
  }

  private prepareAgentFacet(facet: Facet, streamRef?: StreamRef): Facet {
    const prepared = { ...facet } as Facet;

    if (hasAgentGeneratedAspect(prepared) && !prepared.agentId) {
      prepared.agentId = this.id;
    }

    if ((prepared.type === 'speech' || prepared.type === 'thought' || prepared.type === 'action') && !hasAgentGeneratedAspect(prepared)) {
      (prepared as Facet & { agentId: string }).agentId = this.id;
      if (streamRef?.streamId) {
        (prepared as Facet & { streamId: string }).streamId = streamRef.streamId;
      }
    }

    if (streamRef?.streamId && hasStreamAspect(prepared)) {
      prepared.streamId = prepared.streamId || streamRef.streamId;
    }

    if (prepared.type === 'speech' || prepared.type === 'thought') {
      if (!hasContentAspect(prepared)) {
        (prepared as Facet & { content: string }).content = '';
      }
      if (!prepared.streamId && streamRef?.streamId) {
        (prepared as Facet & { streamId: string }).streamId = streamRef.streamId;
      }
    }

    if (prepared.type === 'action' && hasStateAspect(prepared) && streamRef?.streamId) {
      prepared.streamId = prepared.streamId || streamRef.streamId;
    }

    return prepared;
  }

  private registerAgent(): void {
    if (this.agentRegistered) return;

    const agentInfo = {
      id: this.id,
      name: this.agentConfig?.name || this.id || 'Agent',
      type: 'assistant',
      capabilities: ['chat', 'code', 'search'],
      metadata: {
        model: (this.agentConfig as any)?.modelName || 'unknown',
        provider: (this.agentConfig as any)?.provider || 'unknown'
      },
      createdAt: new Date().toISOString()
    };

    this.addOperation({
      type: 'addFacet',
      facet: this.createAgentLifecycleFacet('register', agentInfo)
    });

    this.agentRegistered = true;
  }

  private createAgentLifecycleFacet(
    operation: AgentLifecycleFacet['state']['operation'],
    agentInfo?: AgentLifecycleFacet['state']['agentInfo']
  ): AgentLifecycleFacet {
    return {
      id: `agent-lifecycle-${this.id || 'unknown'}-${Date.now()}`,
      type: 'agent-lifecycle',
      state: {
        operation,
        agentId: this.id || 'unknown',
        agentInfo
      },
      ephemeral: true
    };
  }

  private handleAgentCommand(command: AgentCommand): void {
    if (!this.agent) {
      console.warn('[AgentComponent] No agent set');
      return;
    }

    this.agent.handleCommand(command);

    // If waking up, emit wake event
    if (command.type === 'wake') {
      this.emit({
        topic: 'agent:wake',
        payload: {},
        timestamp: Date.now()
      });
    }
  }

  // Public API for agent state
  handleCommand(command: AgentCommand): void {
    this.handleAgentCommand(command);
  }

  getState(): AgentState {
    if (!this.agent) {
      return { sleeping: false, ignoringSources: new Set(), attentionThreshold: 0 };
    }
    return this.agent.getState();
  }
}

/**
 * @deprecated Use AgentComponent instead - AgentEffector has been consolidated into AgentComponent
 */
export const AgentEffector = AgentComponent;
