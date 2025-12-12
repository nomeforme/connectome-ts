/**
 * ContextTransform - A Transform that renders context for agent activations
 *
 * FLEX Component (constraint: priority 200) that runs during frame processing and creates
 * rendered-context facets for any pending agent activations.
 */

import { Component } from '../spaces/component';
import { ExecutionContext } from '../spaces/types';
import { ReadonlyVEILState } from '../spaces/receptor-effector-types';
import { Facet, hasStateAspect, VEILDelta } from '../veil/types';
import { FrameTrackingHUD } from './frame-tracking-hud';
import { CompressionEngine } from '../compression/types-v2';
import { HUDConfig } from './types-v2';
import { VEILStateManager } from '../veil/veil-state';
import { priorityConstraint, ComponentPriority } from '../spaces/constraints';

export interface ContextTransformConfig {
  compressionEngine?: CompressionEngine;
  defaultOptions?: Partial<HUDConfig>;
  /**
   * Enable thinking mode prefill for chain-of-thought reasoning
   * When enabled, prefills with <thinking> tag to encourage visible reasoning
   * NOTE: This is NOT Anthropic's Extended Thinking API, just prefill-based CoT
   */
  enableThinkingMode?: boolean;
}

export class ContextTransform extends Component {
  constraints = [priorityConstraint(ComponentPriority.TRANSFORM)];

  private hud: FrameTrackingHUD;
  private compressionEngine?: CompressionEngine;
  private defaultOptions?: Partial<HUDConfig>;
  private enableThinkingMode: boolean;
  
  constructor(config: ContextTransformConfig = {}) {
    super();
    this.compressionEngine = config.compressionEngine;
    this.defaultOptions = config.defaultOptions;
    this.enableThinkingMode = config.enableThinkingMode ?? false;
    this.hud = new FrameTrackingHUD();
  }

  /**
   * FLEX execute method - processes frame context for agent activations
   */
  execute(context: ExecutionContext): void {
    const { state } = context;
    this.processActivations(state);
  }

  /**
   * Process activation facets and render context for them
   */
  private processActivations(state: ReadonlyVEILState): void {
    console.log(`[ContextTransform] processActivations() called with ${state.facets.size} facets`);

    // Find activation facets that need context
    for (const [id, facet] of state.facets) {
      if (facet.type === 'agent-activation' && hasStateAspect(facet)) {
        console.log(`[ContextTransform] Found agent-activation facet: ${id}`);
        const activationState = facet.state as Record<string, any>;
        // Skip if context already rendered for this activation
        const contextExists = Array.from(state.facets.values()).some(f => 
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === id
        );
        
        if (contextExists) {
          // console.log(`[ContextTransform] Skipping ${id} - context already exists`);
          continue;
        }
        
        // console.log(`[ContextTransform] Rendering context for activation ${id}...`);
        
        // Get agent-specific options from activation
        const agentOptions = this.buildAgentOptions(activationState);
        
        // Get VEILStateManager from Space
        const space = this.space;
        // console.log(`[ContextTransform] Space:`, !!space, 'hasVEILStateManager:', !!(space?.getVEILStateManager));
        
        if (!space || !space.getVEILStateManager) {
          console.error('[ContextTransform] Cannot access VEILStateManager - component not attached to Space');
          console.error('[ContextTransform] Component:', this.id, 'Space:', space?.id);
          continue;
        }
        
        const veilStateManager = space.getVEILStateManager();
        // console.log(`[ContextTransform] Got VEILStateManager, current sequence:`, veilStateManager.getState().currentSequence);
        
        // Render context using the existing HUD logic
        const fullState = veilStateManager.getState();
        
        // Get current frame from Space to include in rendering
        // This is critical: during execution, the current frame hasn't been finalized
        // to frameHistory yet, so we need to explicitly include it
        const currentFrame = space?.getCurrentFrame();
        
        // Combine frameHistory with current frame so agent sees everything
        const allFrames = [...fullState.frameHistory];
        if (currentFrame) {
          // Only add if not already in history (avoid duplicates)
          const isAlreadyInHistory = fullState.frameHistory.some((f: any) => f.sequence === currentFrame.sequence);
          if (!isAlreadyInHistory) {
            allFrames.push(currentFrame);
          }
        }
        
        const context = this.hud.render(
          allFrames,
          fullState.facets,
          veilStateManager,
          this.compressionEngine,
          agentOptions
        );
        
        // Store the full rendered context object in state
        const contextFacetId = `context-${id}-${Date.now()}`;

        this.addOperation({
          type: 'addFacet',
          facet: {
            id: contextFacetId,
            type: 'rendered-context',
            state: {
              activationId: id,
              tokenCount: context.metadata.totalTokens,
              context: context
            }
          }
        });
      }
    }
  }
  
  private buildAgentOptions(activationState: Record<string, any>): HUDConfig {
    const options: HUDConfig = {
      ...this.defaultOptions,
      // Agent-specific overrides from activation
      systemPrompt: activationState.systemPrompt || this.defaultOptions?.systemPrompt,
      maxTokens: activationState.maxTokens || this.defaultOptions?.maxTokens || 4000,
      metadata: this.defaultOptions?.metadata
    };
    
    // Set focused stream from activation's streamRef
    if (activationState.streamRef?.streamId) {
      options.renderContext = {
        ...this.defaultOptions?.renderContext,
        focusedStream: activationState.streamRef.streamId
      };
    }
    
    // Check if thinking mode should be enabled
    // Priority: activation state > transform config > default options
    const thinkingEnabled = activationState.enableThinkingMode 
      ?? this.enableThinkingMode 
      ?? this.defaultOptions?.formatConfig?.thinking?.enabled 
      ?? false;
    
    // Format configuration for agent output
    if (activationState.targetAgentId) {
      options.formatConfig = {
        assistant: {
          prefix: '<my_turn>\n',
          suffix: '\n</my_turn>'
        },
        // Add thinking configuration if enabled
        ...(thinkingEnabled && {
          thinking: {
            enabled: true,
            openTag: '<thinking>\n',
            closeTag: '\n</thinking>\n'
          }
        })
      };
    }

    return options as HUDConfig;
  }
}
