/**
 * Basic implementation of the AgentInterface
 */

import { 
  AgentInterface, 
  AgentState, 
  AgentCommand, 
  ParsedCompletion,
  AgentConfig,
  ToolDefinition,
  ActionConfig
} from './types';
import { 
  Facet,
  Frame, 
  OutgoingVEILOperation,
  VEILState,
  StreamRef,
  createDefaultTransition,
  hasStateAspect
} from '../veil/types';
import { RenderedContext } from '../hud/types-v2';
import { FrameTrackingHUD } from '../hud/frame-tracking-hud';
import { LLMProvider } from '../llm/llm-interface';
import { VEILStateManager } from '../veil/veil-state';
import { Component } from '../spaces/component';
import { 
  TraceStorage, 
  TraceCategory, 
  getGlobalTracer 
} from '../tracing';
import { BasicAgentConstructorOptions, isAgentOptions } from './agent-factory';
import { SpaceEvent } from '../spaces/types';
import { parseInlineParameters } from './action-parser';
import { stripTurnMarkers } from '../utils/turn-markers';

export class BasicAgent implements AgentInterface {
  private state: AgentState = {
    sleeping: false,
    ignoringSources: new Set(),
    attentionThreshold: 0.5
  };
  
  private config: AgentConfig;
  private hud: FrameTrackingHUD;
  private llmProvider: LLMProvider;
  private veilStateManager: VEILStateManager;
  private tools: Map<string, ToolDefinition> = new Map();
  private tracer: TraceStorage | undefined;
  private agentId: string;
  
  constructor(
    configOrOptions: AgentConfig | BasicAgentConstructorOptions,
    llmProvider?: LLMProvider,
    veilStateManager?: VEILStateManager
  ) {
    // Support both old and new constructor patterns
    if (isAgentOptions(configOrOptions)) {
      // New intuitive pattern
      this.config = configOrOptions.config;
      this.llmProvider = configOrOptions.provider;
      this.veilStateManager = configOrOptions.veilStateManager!;
    } else {
      // Old pattern for backward compatibility
      this.config = configOrOptions;
      this.llmProvider = llmProvider!;
      this.veilStateManager = veilStateManager!;
    }
    
    this.hud = new FrameTrackingHUD();
    this.tracer = getGlobalTracer();
    this.agentId = this.createAgentId(this.config.name);
    
    // Register tools
    if (this.config.tools) {
      for (const tool of this.config.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }
  
  async onFrameComplete(frame: Frame, state: VEILState): Promise<Frame | undefined> {
    this.tracer?.record({
      id: `agent-frame-${frame.sequence}`,
      timestamp: Date.now(),
      level: 'info',
      category: TraceCategory.AGENT_ACTIVATION,
      component: 'BasicAgent',
      operation: 'onFrameComplete',
      data: {
        frameSequence: frame.sequence,
        deltas: frame.deltas.length,
        activeStream: frame.activeStream?.streamId
      }
    });
    
    // Look for activation facets in the state
    const activationFacets = Array.from(state.facets.values())
      .filter(facet => facet.type === 'agent-activation');
    
    if (activationFacets.length === 0) return undefined;
    
    // Check each activation facet
    for (const facet of activationFacets) {
      if (!hasStateAspect(facet)) {
        continue;
      }

      const activation = facet.state as Record<string, any>;

      // Skip if this targets a different agent
      if (activation.targetAgent && activation.targetAgent !== this.config.name) {
        continue;
      }

      if (this.shouldActivate(activation, state)) {
        try {
          // Build context
          const context = this.buildContext(state, frame.activeStream);
          
          // Run cycle
          const response = await this.runCycle(context, frame.activeStream);
          
          // Attach rendered context to the response for debug purposes
          if (response) {
            (response as any).renderedContext = context;
            
            // Prepend operation to remove the activation facet
            response.deltas.unshift({
              type: 'removeFacet',
              id: facet.id
            });
          }
          
          // Return the response frame without recording or processing
          // Space will handle sequencing, recording, and tool processing
          return response;
        } catch (error) {
          console.error('Agent cycle error:', error);
        }
      } else if (this.state.sleeping) {
        // Can't store facets for later - they're in the state, not pending
        // The facet will remain in state until removed
      }
    }
    
    return undefined;
  }
  
  shouldActivate(activation: any, state: VEILState): boolean {
    // Check if sleeping
    if (this.state.sleeping) {
      // Don't activate when sleeping unless explicitly woken
      return false;
    }
    
    // Check ignored sources
    if (activation.source && this.state.ignoringSources.has(activation.source)) {
      return false;
    }
    
    // Check if activation is targeted to a specific agent
    if (activation.targetAgentId || activation.targetAgent) {
      // For ID-based targeting, we need the agent to know its own ID
      // This is typically set by AgentComponent but we check by name for now
      if (activation.targetAgent && activation.targetAgent !== this.config.name) {
        return false;
      }
      
      // TODO: Once agents know their IDs, check targetAgentId as well
      // For now, targetAgentId requires AgentComponent to pass the ID
    }
    
    // Activate if not sleeping, not ignored, and either not targeted or targeted to this agent
    return true;
  }
  
  async runCycle(context: RenderedContext, streamRef?: StreamRef): Promise<Frame> {
    const cycleSpan = this.tracer?.startSpan('runCycle', 'BasicAgent');
    
    try {
      // Discover tools from VEIL before each cycle
      this.discoverToolsFromVEIL();
      
      // Log context size
      this.tracer?.record({
        id: `llm-context-${Date.now()}`,
        timestamp: Date.now(),
        level: 'info',
        category: TraceCategory.AGENT_CONTEXT_BUILD,
        component: 'BasicAgent',
        operation: 'runCycle',
        data: {
          messages: context.messages.length,
          totalTokens: context.metadata.totalTokens,
          activeStream: streamRef?.streamId
        },
        parentId: cycleSpan?.id
      });
      
      // Debug: Log messages for interactive box test
      if (this.config.name === 'interactive-explorer') {
        console.log('\n[Agent] Messages being sent:');
        context.messages.forEach((msg, i) => {
          console.log(`[${i}] ${msg.role}: ${msg.content.slice(0, 100)}...`);
        });
      }
      
      // Call LLM
      const response = await this.llmProvider.generate(
        context.messages,
        {
          maxTokens: this.config.defaultMaxTokens || 1000,
          temperature: this.config.defaultTemperature || 1.0,
          stopSequences: ['</my_turn>'],
          formatConfig: this.buildFormatConfig()
        }
      );
      
      console.log(`[BasicAgent] LLM response content (${response.content.length} chars):`, response.content.substring(0, 200));
      
      this.tracer?.record({
        id: `llm-response-${Date.now()}`,
        timestamp: Date.now(),
        level: 'info',
        category: TraceCategory.AGENT_LLM_CALL,
        component: 'BasicAgent',
        operation: 'runCycle',
        data: {
          provider: this.llmProvider.getProviderName(),
          tokensUsed: response.tokensUsed,
          responseLength: response.content.length,
          content: response.content.substring(0, 200) + '...'
        },
        parentId: cycleSpan?.id
      });
      
      // Parse the response
      const parsed = this.parseCompletion(response.content);
      
      console.log(`[BasicAgent] parseCompletion returned ${parsed.operations.length} operations`);
      
      this.tracer?.record({
        id: `parse-response-${Date.now()}`,
        timestamp: Date.now(),
        level: 'debug',
        category: TraceCategory.AGENT_RESPONSE_PARSE,
        component: 'BasicAgent',
        operation: 'parseCompletion',
        data: {
          operations: parsed.operations.length,
          hasMoreToSay: parsed.hasMoreToSay
        },
        parentId: cycleSpan?.id
      });
      
      // Apply stream routing to speak operations
      const operations = this.applyStreamRouting(parsed.operations, streamRef);
      
      // Create agent-generated frame without sequence (Space will assign it)
      const timestamp = new Date().toISOString();
      const transition = createDefaultTransition(-1, timestamp);
      transition.veilOps = operations;

      // Convert parsed events to SpaceEvents
      const spaceEvents = (parsed.events || []).map(ev => ({
        id: `agent-event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        topic: ev.topic,
        payload: ev.payload,
        timestamp: Date.now(),
        source: { componentId: 'agent', componentPath: [], componentType: 'Agent' }
      }));

      const frame: Frame = {
        sequence: -1, // Placeholder - Space will assign proper sequence
        timestamp,
        events: spaceEvents,
        deltas: operations,
        transition
      };
      
      // Attach raw LLM completion for debug purposes
      (frame as any).rawCompletion = {
        content: response.content,
        tokensUsed: response.tokensUsed,
        provider: this.llmProvider.getProviderName(),
        timestamp: new Date().toISOString()
      };
      
      return frame;
    } finally {
      if (cycleSpan) {
        this.tracer?.endSpan(cycleSpan.id);
      }
    }
  }

  /**
   * Streaming version of runCycle - yields chunks as they arrive from the LLM
   *
   * @param context - Rendered context for the agent
   * @param streamRef - Optional stream reference for routing
   * @yields Streaming chunks (without accumulated content - ResponseHandler tracks accumulation)
   */
  async *runCycleStreaming(
    context: RenderedContext,
    streamRef?: StreamRef,
    abortSignal?: AbortSignal
  ): AsyncIterable<{
    chunk: string;
    done: boolean;
    tokensUsed?: number;
    modelId?: string;
  }> {
    const cycleSpan = this.tracer?.startSpan('runCycleStreaming', 'BasicAgent');

    try {
      // Discover tools from VEIL before each cycle
      this.discoverToolsFromVEIL();

      // Log context size
      this.tracer?.record({
        id: `llm-stream-context-${Date.now()}`,
        timestamp: Date.now(),
        level: 'info',
        category: TraceCategory.AGENT_CONTEXT_BUILD,
        component: 'BasicAgent',
        operation: 'runCycleStreaming',
        data: {
          messages: context.messages.length,
          totalTokens: context.metadata.totalTokens,
          activeStream: streamRef?.streamId,
          streaming: true
        },
        parentId: cycleSpan?.id
      });

      // Stream from LLM
      // Note: We don't track accumulated here - ResponseHandler does that internally
      let totalChars = 0;
      let lastTokensUsed: number | undefined;
      let lastModelId: string | undefined;

      for await (const chunk of this.llmProvider.generateStream(
        context.messages,
        {
          maxTokens: this.config.defaultMaxTokens || 1000,
          temperature: this.config.defaultTemperature || 1.0,
          stopSequences: ['</my_turn>'],
          formatConfig: this.buildFormatConfig(),
          signal: abortSignal
        }
      )) {
        // Check for abort before processing each chunk
        if (abortSignal?.aborted) {
          console.log('[BasicAgent] Stream aborted by signal');
          return;
        }
        totalChars += chunk.content.length;

        if (chunk.done) {
          lastTokensUsed = chunk.tokensUsed;
          lastModelId = chunk.modelId;
        }

        yield {
          chunk: chunk.content,
          done: chunk.done,
          tokensUsed: chunk.tokensUsed,
          modelId: chunk.modelId
        };
      }

      console.log(`[BasicAgent] Streaming complete (${totalChars} chars)`);

      this.tracer?.record({
        id: `llm-stream-response-${Date.now()}`,
        timestamp: Date.now(),
        level: 'info',
        category: TraceCategory.AGENT_LLM_CALL,
        component: 'BasicAgent',
        operation: 'runCycleStreaming',
        data: {
          provider: this.llmProvider.getProviderName(),
          tokensUsed: lastTokensUsed,
          responseLength: totalChars,
          streaming: true
        },
        parentId: cycleSpan?.id
      });

    } finally {
      if (cycleSpan) {
        this.tracer?.endSpan(cycleSpan.id);
      }
    }
  }

  parseCompletion(completion: string): ParsedCompletion {
    const operations: OutgoingVEILOperation[] = [];
    const events: Array<{ topic: string; payload: any }> = [];
    let hasMoreToSay = false;
    
    // Normalize turn markers so downstream rendering doesn't double-wrap agent turns
    let turnContent = stripTurnMarkers(completion);
    
    // For now, assume the turn is complete if we got a response
    // In a real implementation, we'd check if we hit max tokens
    hasMoreToSay = false;
    
    // First, protect backticked content from being parsed as actions
    const backtickPlaceholders: string[] = [];
    let protectedContent = turnContent.replace(/`([^`]+)`/g, (match, content) => {
      const placeholder = `__BACKTICK_${backtickPlaceholders.length}__`;
      backtickPlaceholders.push(match);
      return placeholder;
    });
    
    // Parse {@element.action} syntax (curly brace syntax to avoid conflicts with @ mentions)
    // Supports hierarchical paths like {@chat.general.say} and hyphens in names {@box-1.open}
    const actionRegex = /\{@([\w.-]+)(?:\s*\(([^)]*)\)|\s*\{([\s\S]*?)\})?\}/g;
    let actionMatch;
    while ((actionMatch = actionRegex.exec(protectedContent)) !== null) {
      const fullPath = actionMatch[1];
      const inlineParams = actionMatch[2];
      const blockParams = actionMatch[3];
      
      // Split the path (e.g., "chat.general.say" → ["chat", "general", "say"])
      const pathParts = fullPath.split('.');
      
      let parameters: Record<string, any> = {};
      
      if (inlineParams) {
        // Parse inline params: {@box.open("gently")} or {@box.open(speed="slow", careful=true)}
        parameters = parseInlineParameters(inlineParams);
      } else if (blockParams) {
        // Parse block parameters: {@email.send { to: alice@example.com, subject: Test }}
        // This is a simplified parser - could be enhanced
        const lines = blockParams.trim().split('\n');
        let currentKey: string | null = null;
        let currentValue: string[] = [];
        
        for (const line of lines) {
          const keyMatch = line.match(/^\s*(\w+):\s*(.*)/);
          if (keyMatch) {
            // Save previous key/value
            if (currentKey) {
              parameters[currentKey] = currentValue.join('\n').trim();
            }
            currentKey = keyMatch[1];
            currentValue = [keyMatch[2]];
          } else if (currentKey && line.trim()) {
            // Continuation of previous value
            currentValue.push(line);
          }
        }
        // Save last key/value
        if (currentKey) {
          parameters[currentKey] = currentValue.join('\n').trim();
        }
      }
      
      // Restore backticks in parameters
      if (Object.keys(parameters).length > 0) {
        for (const key in parameters) {
          if (typeof parameters[key] === 'string') {
            let value = parameters[key];
            backtickPlaceholders.forEach((original, index) => {
              value = value.replace(`__BACKTICK_${index}__`, original.slice(1, -1)); // Remove backticks
            });
            parameters[key] = value;
          }
        }
      }
      
      // Convert element action to action facet
      // Path like ['dispenser', 'dispense'] becomes toolName 'dispenser.dispense'
      const toolName = pathParts.join('.');
      operations.push({
        type: 'addFacet',
        facet: this.createActionFacet(
          toolName,
          Object.keys(parameters).length > 0 ? parameters : {}
        )
      });
      
      // Emit element:action event ONLY if tool is registered (discovered from VEIL)
      const tool = this.tools.get(toolName);
      if (tool?.emitEvent) {
        events.push({
          topic: tool.emitEvent.topic,
          payload: {
            path: pathParts,
            action: pathParts[pathParts.length - 1],
            parameters: Object.keys(parameters).length > 0 ? parameters : {},
            ...(tool.emitEvent.payloadTemplate || {})
          }
        });
      } else {
        console.warn(`[BasicAgent] Tool ${toolName} not registered - action will not execute`);
      }
    }
    
    // Parse thoughts
    const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
    let thoughtMatch;
    while ((thoughtMatch = thoughtRegex.exec(turnContent)) !== null) {
      operations.push({
        type: 'addFacet',
        facet: this.createThoughtFacet(thoughtMatch[1].trim())
      });
    }
    
    // Parse tool calls (legacy XML format)
    const toolRegex = /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
    let toolMatch;
    while ((toolMatch = toolRegex.exec(turnContent)) !== null) {
      const toolName = toolMatch[1];
      const paramContent = toolMatch[2];

      // Parse parameters
      const params: Record<string, any> = {};
      const paramRegex = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(paramContent)) !== null) {
        params[paramMatch[1]] = this.parseParameterValue(paramMatch[2]);
      }

      operations.push({
        type: 'addFacet',
        facet: this.createActionFacet(toolName, params)
      });
    }

    // Parse <action> tags (new format, supports multiline content for Lua scripts)
    // Supports: <action name="lua" timeout="30000">...multiline content...</action>
    // Also supports CDATA: <action name="lua"><![CDATA[...]]></action>
    const actionTagRegex = /<action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/action>/g;
    let actionTagMatch;
    while ((actionTagMatch = actionTagRegex.exec(turnContent)) !== null) {
      const actionName = actionTagMatch[1];
      const attributesStr = actionTagMatch[2];
      let content = actionTagMatch[3];

      // Parse attributes (e.g., timeout="30000")
      const attributes: Record<string, any> = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
        const key = attrMatch[1];
        let value: any = attrMatch[2];
        // Parse numeric values
        if (/^\d+$/.test(value)) {
          value = parseInt(value, 10);
        } else if (/^\d+\.\d+$/.test(value)) {
          value = parseFloat(value);
        }
        attributes[key] = value;
      }

      // Handle CDATA wrapper if present
      const cdataMatch = content.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
      if (cdataMatch) {
        content = cdataMatch[1];
      } else {
        // Trim leading/trailing whitespace but preserve internal formatting
        content = content.replace(/^\n/, '').replace(/\n\s*$/, '');
      }

      // Create action facet with content as the main payload
      // For 'lua' actions, content is the script code
      const params: Record<string, any> = {
        ...attributes,
        content
      };

      operations.push({
        type: 'addFacet',
        facet: this.createActionFacet(actionName, params)
      });

      // Emit event for registered tools
      const tool = this.tools.get(actionName);
      if (tool?.emitEvent) {
        events.push({
          topic: tool.emitEvent.topic,
          payload: {
            action: actionName,
            parameters: params,
            ...(tool.emitEvent.payloadTemplate || {})
          }
        });
      }
    }
    
    // Extract speech (everything not in special tags or actions)
    let speechContent = turnContent;
    
    // Protect backticks before removing content
    const speechBacktickPlaceholders: string[] = [];
    let protectedSpeech = speechContent.replace(/`([^`]+)`/g, (match, content) => {
      const placeholder = `__SPEECH_BACKTICK_${speechBacktickPlaceholders.length}__`;
      speechBacktickPlaceholders.push(match);
      return placeholder;
    });
    
    // Remove thoughts
    protectedSpeech = protectedSpeech.replace(/<thought>[\s\S]*?<\/thought>/g, '');
    
    // Remove tool calls (legacy XML format)
    protectedSpeech = protectedSpeech.replace(/<tool_call\s+name="[^"]+"[\s\S]*?<\/tool_call>/g, '');

    // Remove <action> tags (new format with multiline content)
    protectedSpeech = protectedSpeech.replace(/<action\s+name="[^"]+"\s*[^>]*>[\s\S]*?<\/action>/g, '');

    // Remove {@element.action} syntax (curly brace syntax to avoid conflicts with @ mentions)
    // This won't match Discord mentions like <@username> or <#channel>
    protectedSpeech = protectedSpeech.replace(/\{@[\w.-]+(?:\s*\([^)]*\)|\s*\{[\s\S]*?\})?\}/g, '');
    
    // Restore backticks
    speechContent = stripTurnMarkers(protectedSpeech);
    speechBacktickPlaceholders.forEach((original, index) => {
      speechContent = speechContent.replace(`__SPEECH_BACKTICK_${index}__`, original);
    });
    
    // Clean up whitespace
    speechContent = speechContent.trim();
    
    if (speechContent) {
      operations.push({
        type: 'addFacet',
        facet: this.createSpeechFacet(speechContent)
      });
    }
    
    return { 
      operations, 
      events: events.length > 0 ? events : undefined,
      hasMoreToSay, 
      rawContent: completion 
    };
  }
  
  handleCommand(command: AgentCommand): void {
    switch (command.type) {
      case 'sleep':
        this.state.sleeping = true;
        // TODO: Handle duration with timers
        break;
        
      case 'wake':
        this.state.sleeping = false;
        // Activation facets persist in state and will be processed when awake
        console.log(`[Agent] Waking up`);
        break;
        
      case 'ignore':
        this.state.ignoringSources.add(command.source);
        break;
        
      case 'unignore':
        this.state.ignoringSources.delete(command.source);
        break;
        
      case 'setThreshold':
        this.state.attentionThreshold = command.threshold;
        break;
    }
  }
  
  /**
   * Enable automatic action registration for elements
   * When enabled, elements with handleAction will have their actions registered automatically
   */
  enableAutoActionRegistration(): void {
    this._autoActionRegistration = true;
  }
  
  private _autoActionRegistration = false;
  
  /**
   * Register an element's actions automatically
   * Called by Space when elements are added
   */
  registerElementAutomatically(element: Component): void {
    if (!this._autoActionRegistration) return;
    
    // Look for components with declared actions
    const componentClass = element.constructor as any;
    const declaredActions = componentClass.actions;
    
    if (declaredActions && Object.keys(declaredActions).length > 0) {
      this.registerElementActions(element, declaredActions);
    }
    
    /*
    // Deprecated: logic for iterating components of an element
    const components = (element as any)._components || [];
    
    for (const component of components) {
      const componentClass = component.constructor as any;
      const declaredActions = componentClass.actions;
      
      if (declaredActions && Object.keys(declaredActions).length > 0) {
        // Register all actions declared by this component
        this.registerElementActions(element, declaredActions);
      }
    }
    */
    
    // Special case: if it's a box with no declared actions, add a generic open action
    if (element.id.startsWith('box-')) {
      const hasOpenAction = this.tools.has(`${element.id}.open`);
      if (!hasOpenAction) {
        this.registerElementActions(element, {
          open: 'Open this box'
        });
      }
    }
  }
  
  /**
   * Register multiple actions for an element at once
   */
  registerElementActions(element: Component | string, actions: Record<string, string | ActionConfig>): void {
    const componentId = typeof element === 'string' ? element : element.id;
    
    for (const [actionName, config] of Object.entries(actions)) {
      const description = typeof config === 'string' ? config : config.description;
      const params = typeof config === 'object' ? config.params : undefined;
      
      let parameters: any = {};
      
      // Auto-generate parameter schema from array of allowed values
      if (params && Array.isArray(params)) {
        parameters = {
          type: 'object',
          properties: {
            value: { 
              type: 'string', 
              enum: params,
              description: `One of: ${params.join(', ')}`
            }
          }
        };
      } else if (params && typeof params === 'object') {
        parameters = params;
      }
      
      this.registerTool({
        name: `${componentId}.${actionName}`,
        description,
        parameters,
        componentPath: [componentId],
        emitEvent: {
          topic: 'element:action',
          payloadTemplate: {}
        }
      });
    }
  }
  
  getState(): AgentState {
    return {
      sleeping: this.state.sleeping,
      ignoringSources: new Set(this.state.ignoringSources),
      attentionThreshold: this.state.attentionThreshold
    };
  }
  
  /**
   * Discover tools from action-definition facets in VEIL
   * This is how components declare their actions persistently
   */
  private discoverToolsFromVEIL(): void {
    const veilState = this.veilStateManager.getState();
    let discoveredCount = 0;
    
    console.log(`[BasicAgent] Scanning ${veilState.facets.size} facets for action-definitions...`);
    
    // Scan for action-definition facets
    for (const [facetId, facet] of veilState.facets.entries()) {
      if (facet.type === 'action-definition') {
        console.log(`[BasicAgent] Found action-definition facet: ${facetId}`, facet);
        const attrs = (facet as any).attributes || {};
        const toolName = attrs.toolName || facetId;
        
        // Skip if already registered
        if (this.tools.has(toolName)) continue;
        
        const componentId = attrs.componentId;
        const actionName = attrs.actionName;
        
        // Register tool from VEIL facet
        this.tools.set(toolName, {
          name: toolName,
          description: attrs.description || facet.content || `Call ${toolName}`,
          parameters: attrs.parameters || {},
          componentPath: componentId ? [componentId] : [],
          emitEvent: {
            topic: 'element:action',
            payloadTemplate: {}
          }
        });
        
        discoveredCount++;
      }
    }
    
    if (discoveredCount > 0) {
      console.log(`[BasicAgent] Discovered ${discoveredCount} tools from VEIL, total: ${this.tools.size}`);
    }
  }
  
  /**
   * Register a tool that the agent can use
   * Can accept either a full ToolDefinition or just a tool name string for common patterns
   */
  registerTool(toolOrName: ToolDefinition | string): void {
    let tool: ToolDefinition;
    
    if (typeof toolOrName === 'string') {
      // Smart defaults for string-based registration
      const parts = toolOrName.split('.');
      
      tool = {
        name: toolOrName,
        description: `Perform ${toolOrName} action`,
        parameters: {},
        componentPath: parts.slice(0, -1),
        emitEvent: {
          topic: 'element:action',
          payloadTemplate: {}
        }
      };
    } else {
      tool = toolOrName;
    }
    
    if (!tool.name) {
      throw new Error('Tool must have a name');
    }
    this.tools.set(tool.name, tool);
  }
  
  
  /**
   * Check if there are pending activations that should be processed
   * @deprecated Activation facets remain in state until processed
   */
  hasPendingActivations(): boolean {
    return false;
  }
  
  private buildContext(state: VEILState, streamRef?: StreamRef): RenderedContext {
    // Note: Pending activations removed - activation facets remain in state
    // Note: No compression engine - compression is handled by CompressionTransform + ContextTransform in RETM architecture
    
    // Render using HUD (without compression)
    return this.hud.render(
      state.frameHistory,
      new Map(state.facets),
      this.veilStateManager,
      undefined, // No compression - use RETM transforms for compression support
      {
        systemPrompt: this.config.systemPrompt,
        maxTokens: this.config.contextTokenBudget || 4000,  // Context window budget, not generation limit
        metadata: {
        },
        formatConfig: this.buildFormatConfig(),
        // Pass agent name for debugging
        name: this.config.name
      } as any
    );
  }
  
  /**
   * Build format config for LLM calls, including thinking mode if enabled
   */
  private buildFormatConfig() {
    const formatConfig: {
      assistant: { prefix: string; suffix: string };
      thinking?: { enabled: boolean; openTag: string; closeTag: string };
    } = {
      assistant: {
        prefix: '<my_turn>\n',
        suffix: '\n</my_turn>'
      }
    };
    
    // Add thinking configuration if enabled
    if (this.config.enableThinkingMode) {
      formatConfig.thinking = {
        enabled: true,
        openTag: '<thinking>\n',
        closeTag: '\n</thinking>\n'
      };
    }
    
    return formatConfig;
  }
  
  private applyStreamRouting(
    deltas: OutgoingVEILOperation[], 
    streamRef?: StreamRef
  ): OutgoingVEILOperation[] {
    return deltas.map(op => {
      if (op.type === 'addFacet' && streamRef) {
        const facet = op.facet;
        if ((facet.type === 'speech' || facet.type === 'thought' || facet.type === 'action')) {
          return {
            ...op,
            facet: {
              ...facet,
              streamId: streamRef.streamId
            }
          };
        }
      }
      return op;
    });
  }

  private createActionFacet(toolName: string, parameters: Record<string, any>): Facet {
    return {
      id: this.generateFacetId('agent-action'),
      type: 'action',
      content: JSON.stringify(parameters),
      state: {
        toolName,
        parameters
      },
      agentId: this.resolveAgentId(),
      agentName: this.resolveAgentName(),
      streamId: this.getDefaultStreamId()
    };
  }

  private createSpeechFacet(content: string): Facet {
    return {
      id: this.generateFacetId('agent-speech'),
      type: 'speech',
      content,
      agentId: this.resolveAgentId(),
      agentName: this.resolveAgentName(),
      streamId: this.getDefaultStreamId()
    };
  }

  private createThoughtFacet(content: string): Facet {
    return {
      id: this.generateFacetId('agent-thought'),
      type: 'thought',
      content,
      agentId: this.resolveAgentId(),
      agentName: this.resolveAgentName(),
      streamId: this.getDefaultStreamId()
    };
  }

  private createAgentId(name?: string): string {
    if (name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    return `agent-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateFacetId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private resolveAgentId(): string {
    return this.agentId;
  }

  private resolveAgentName(): string | undefined {
    return this.config.name;
  }

  private getDefaultStreamId(): string {
    return 'default';
  }

  private parseParameterValue(value: string): any {
    // Try to parse as JSON first
    try {
      return JSON.parse(value);
    } catch {
      // If not JSON, return as string
      return value;
    }
  }
}
