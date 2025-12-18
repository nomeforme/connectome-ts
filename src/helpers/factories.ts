/**
 * Factory functions for creating common Connectome objects
 * These helpers reduce boilerplate and guide developers to create valid structures
 */

import type { 
  SpaceEvent, 
  ComponentRef
} from '../spaces/types';
import type {
  VEILDelta,
  Facet,
  AgentActivationFacet,
  SpeechFacet,
  ThoughtFacet,
  ActionFacet,
  EventFacet,
  StateFacet,
  AmbientFacet,
  StreamRewriteFacet,
  InternalStateFacet
} from '../veil/types';
// import { Element } from '../spaces/element'; // Removed
import { validateFacet } from '../validation/facet-validation';
import { ConstraintFacet, priorityConstraint } from '../spaces/constraints';

// Counter for friendly sequential IDs
let idCounter = 0;

/**
 * Generate a friendly, readable ID
 * @param prefix - The prefix for the ID
 * @param unique - Whether to add a unique suffix (default: true)
 * @returns A friendly ID like "note-1" or "search-results"
 */
export function friendlyId(prefix: string, unique: boolean = true): string {
  if (!unique) return prefix;
  return `${prefix}-${++idCounter}`;
}

// ============================================
// Facet builder helpers (aspect-aware)
// ============================================

export interface SpeechFacetInit {
  content: string;
  agentId: string;
  streamId: string;
  id?: string;
  agentName?: string;
  streamType?: string;
}

export function createSpeechFacet(init: SpeechFacetInit): SpeechFacet {
  const { content, agentId, streamId, id, agentName, streamType } = init;
  const facet: SpeechFacet = {
    id: id ?? friendlyId('speech'),
    type: 'speech',
    content,
    agentId,
    ...(agentName ? { agentName } : {}),
    streamId,
    ...(streamType ? { streamType } : {})
  };
  
  // Validate before returning
  validateFacet(facet, 'speech', { context: 'createSpeechFacet' });
  
  return facet;
}

export interface ThoughtFacetInit {
  content: string;
  agentId: string;
  streamId: string;
  id?: string;
  agentName?: string;
  streamType?: string;
}

export function createThoughtFacet(init: ThoughtFacetInit): ThoughtFacet {
  const { content, agentId, streamId, id, agentName, streamType } = init;
  const facet: ThoughtFacet = {
    id: id ?? friendlyId('thought'),
    type: 'thought',
    content,
    agentId,
    ...(agentName ? { agentName } : {}),
    streamId,
    ...(streamType ? { streamType } : {})
  };
  
  // Validate before returning
  validateFacet(facet, 'thought', { context: 'createThoughtFacet' });
  
  return facet;
}

export interface ActionFacetInit {
  toolName: string;
  parameters?: Record<string, any>;
  agentId: string;
  streamId: string;
  content?: string;
  id?: string;
  agentName?: string;
  streamType?: string;
}

export function createActionFacet(init: ActionFacetInit): ActionFacet {
  const {
    toolName,
    parameters = {},
    agentId,
    agentName,
    streamId,
    streamType,
    content = `@${toolName}`,
    id
  } = init;

  const facet: ActionFacet = {
    id: id ?? friendlyId('action'),
    type: 'action',
    content,
    state: {
      toolName,
      parameters
    },
    agentId,
    ...(agentName ? { agentName } : {}),
    streamId,
    ...(streamType ? { streamType } : {})
  };
  
  // Validate before returning
  validateFacet(facet, 'action', { context: 'createActionFacet' });
  
  return facet;
}

export interface EventFacetInit {
  content: string;
  source: string;
  eventType: string;
  streamId: string;
  metadata?: any;
  id?: string;
  streamType?: string;
}

export function createEventFacet(init: EventFacetInit): EventFacet {
  const { content, source, eventType, metadata, streamId, streamType, id } = init;
  const facet: EventFacet = {
    id: id ?? friendlyId('event'),
    type: 'event',
    content,
    state: {
      source,
      eventType,
      ...(metadata !== undefined ? { metadata } : {})
    },
    streamId,
    ...(streamType ? { streamType } : {})
  };
  
  // Validate before returning
  validateFacet(facet, 'event', { context: 'createEventFacet' });
  
  return facet;
}

export interface StateFacetInit {
  content: string;
  entityType: StateFacet['entityType'];
  entityId: string;
  state?: Record<string, any>;
  scopes?: string[];
  id?: string;
  // Renderers can be provided as functions (will be converted to strings) or as strings
  attributeRenderers?: Record<string, ((value: any) => string | null) | string>;
  transitionRenderers?: Record<string, ((newValue: any, oldValue: any) => string | null) | string>;
}

export function createStateFacet(init: StateFacetInit): StateFacet {
  const { 
    content, 
    entityType, 
    entityId, 
    state = {}, 
    scopes = [], 
    id,
    attributeRenderers,
    transitionRenderers
  } = init;
  
  const facet: StateFacet = {
    id: id ?? friendlyId('state'),
    type: 'state',
    content,
    state,
    entityType,
    entityId,
    scopes
  };
  
  // Add renderers if provided, converting functions to strings
  if (attributeRenderers) {
    facet.attributeRenderers = {};
    for (const [key, renderer] of Object.entries(attributeRenderers)) {
      facet.attributeRenderers[key] = typeof renderer === 'function' 
        ? `return (${renderer.toString()})(value);`
        : renderer;
    }
  }
  if (transitionRenderers) {
    facet.transitionRenderers = {};
    for (const [key, renderer] of Object.entries(transitionRenderers)) {
      facet.transitionRenderers[key] = typeof renderer === 'function'
        ? `return (${renderer.toString()})(newValue, oldValue);`
        : renderer;
    }
  }
  
  // Validate before returning
  validateFacet(facet, 'state', { context: 'createStateFacet' });
  
  return facet;
}

export interface AmbientFacetInit {
  content: string;
  streamId: string;
  streamType?: string;
  id?: string;
}

export function createAmbientFacet(init: AmbientFacetInit): AmbientFacet {
  const { content, streamId, streamType, id } = init;
  const facet: AmbientFacet = {
    id: id ?? friendlyId('ambient'),
    type: 'ambient',
    content,
    streamId,
    ...(streamType ? { streamType } : {})
  };
  
  // Validate before returning
  validateFacet(facet, 'ambient', { context: 'createAmbientFacet' });
  
  return facet;
}

export interface StreamRewriteFacetInit {
  operation: StreamRewriteFacet['state']['operation'];
  streamId: string;
  streamType?: string;
  id?: string;
}

export function createStreamRewriteFacet(init: StreamRewriteFacetInit): StreamRewriteFacet {
  const { operation, streamId, streamType, id } = init;
  const facet: StreamRewriteFacet = {
    id: id ?? friendlyId('stream-change'),
    type: 'stream-change',
    state: {
      operation,
      streamId,
      ...(streamType ? { streamType } : {})
    },
    ephemeral: true
  };
  
  // Validate before returning
  validateFacet(facet, 'stream-change', { context: 'createStreamRewriteFacet' });
  
  return facet;
}

export interface InternalStateFacetInit {
  componentId: string;
  state: Record<string, any>;
  id?: string;
}

export function createInternalStateFacet(init: InternalStateFacetInit): InternalStateFacet {
  const { componentId, state, id } = init;
  const facet: InternalStateFacet = {
    id: id ?? friendlyId('internal-state'),
    type: 'internal-state',
    componentId,
    state
  };
  
  // Note: InternalStateFacet intentionally has no ContentAspect
  // It's not rendered to agents, only used for component persistence
  
  return facet;
}

/**
 * Creates a properly structured SpaceEvent
 * @param topic - The event topic
 * @param source - Either an Element instance or a string ID (will create a minimal ComponentRef)
 * @param payload - Optional event payload
 * @returns A valid SpaceEvent
 * 
 * @example
 * // With an Object (like Component)
 * const event = createSpaceEvent('user:action', myComponent, { action: 'click' });
 * 
 * // With just an ID
 * const event = createSpaceEvent('test:event', 'test-element-id');
 */
export function createSpaceEvent(
  topic: string,
  source: { id: string; getPath?: () => string[]; constructor: { name: string } } | string | ComponentRef,
  payload?: any
): SpaceEvent {
  let elementRef: ComponentRef;
  
  if (typeof source === 'string') {
    // Create minimal ComponentRef from string ID
    elementRef = {
      componentId: source,
      componentPath: ['root'],
      componentType: 'Component'
    };
  } else if ('componentId' in source && 'componentPath' in source) {
    // Already an ComponentRef
    elementRef = source as ComponentRef;
  } else {
    // It's a Component-like object, extract the ref
    elementRef = {
      componentId: source.id,
      componentPath: source.getPath ? source.getPath() : ['root', source.id],
      componentType: source.constructor.name
    };
  }
  
  return {
    topic,
    source: elementRef,
    payload,
    timestamp: Date.now()
  };
}

/**
 * Creates an ComponentRef from various input types
 * @param elementOrId - Component instance, existing ComponentRef, or string ID
 * @returns A valid ComponentRef
 * 
 * @example
 * const ref = createComponentRef(myComponent);
 * const ref2 = createComponentRef('my-component-id');
 * const ref3 = createComponentRef(existingRef); // passes through
 */
export function createComponentRef(elementOrId: { id: string; getPath?: () => string[]; constructor: { name: string } } | ComponentRef | string): ComponentRef {
  if (typeof elementOrId === 'string') {
    return {
      componentId: elementOrId,
      componentPath: ['root'],
      componentType: 'Component'
    };
  }

  if ('componentId' in elementOrId && 'componentPath' in elementOrId) {
    // Already an ComponentRef
    return elementOrId as ComponentRef;
  }

  // It's a Component
  return {
    componentId: elementOrId.id,
    componentPath: elementOrId.getPath ? elementOrId.getPath() : ['root', elementOrId.id],
    componentType: elementOrId.constructor.name
  };
}

/**
 * Creates an agent activation facet
 * @param reason - Why the agent is being activated
 * @param options - Additional activation options including optional ID
 * @returns A valid agent activation facet
 * 
 * @example
 * const activation = createAgentActivation('user:message', {
 *   id: 'help-request-1',  // Optional stable ID
 *   priority: 'high',
 *   source: 'discord-chat',
 *   messageId: '12345'
 * });
 */
export function createAgentActivation(
  reason: string,
  options: {
    id?: string;
    priority?: 'low' | 'normal' | 'high' | 'critical';
    sourceAgentId?: string;
    streamId?: string;
    streamType?: string;
    [key: string]: any;
  } = {}
): AgentActivationFacet {
  const { id, priority = 'normal', sourceAgentId, streamId, streamType, ...extraState } = options;

  const facet: AgentActivationFacet = {
    id: id || friendlyId('activation'),
    type: 'agent-activation',
    state: {
      reason,
      priority,
      ...(sourceAgentId ? { sourceAgentId } : {}),
      // Nest extra state under metadata for consistent access pattern
      ...(Object.keys(extraState).length > 0 ? { metadata: extraState } : {})
    },
    // streamId/streamType are top-level facet properties for stream association
    ...(streamId ? { streamId } : {}),
    ...(streamType ? { streamType } : {}),
    ephemeral: true
  };

  // Validate before returning
  validateFacet(facet, 'agent-activation', { context: 'createAgentActivation' });

  return facet;
}


// VEIL Delta Helpers

export function addFacet(facet: Facet): VEILDelta {
  return {
    type: 'addFacet',
    facet
  };
}

export function removeFacet(id: string): VEILDelta {
  return {
    type: 'removeFacet',
    id
  };
}

/**
 * Helper to wrap facets in addFacet deltas
 * For migrating receptors to return VEILDelta[]
 */
export function wrapFacetsAsDeltas(facets: Facet[]): VEILDelta[] {
  return facets.map(facet => ({
    type: 'addFacet' as const,
    facet
  }));
}

export function rewriteFacet(id: string, changes: Partial<Facet>): VEILDelta {
  return {
    type: 'rewriteFacet',
    id,
    changes
  };
}

// Deprecated aliases - use rewriteFacet for clarity
export const changeState = rewriteFacet;
export const updateState = rewriteFacet;
export const changeFacet = rewriteFacet;  // Backward compat

/**
 * Create a component state facet for VEIL-based component persistence.
 * Includes nested constraint facet for ordering.
 */
export function createComponentStateFacet(init: {
  componentId: string;
  componentType: string;
  parentId?: string;
  initialState?: Record<string, any>;
  constraints?: ConstraintFacet[];
}): Facet {
  const constraintsFacetId = `constraints:${init.componentId}`;

  // Use provided constraints or default to priority 0
  const constraints = init.constraints && init.constraints.length > 0
    ? init.constraints
    : [priorityConstraint(0, 'component-state-factory:default')];

  const constraintsChildFacet = {
    id: constraintsFacetId,
    type: 'component-constraints',
    state: { constraints }
  };

  return {
    id: `component-state:${init.componentId}`,
    type: 'component-state',
    componentType: init.componentType,
    componentId: init.componentId,
    parentId: init.parentId || 'root',
    state: init.initialState || {},
    children: [constraintsChildFacet]
  } as any;
}

/**
 * Create or update state facets from a key-value dictionary
 * Returns state-change facets that will be applied by VEILStateManager
 * 
 * @param baseId - Base ID for facets (e.g., 'discord-lastread')
 * @param updates - Dictionary of key → value updates
 * @param currentState - Optional ReadonlyVEILState to read old values
 * @returns Array of state-change facets
 * 
 * @example
 * // In a Receptor
 * return [
 *   messageFacet,
 *   ...updateStateFacets('discord-lastread', { 
 *     'channel-123': 'msg-456',
 *     'channel-789': 'msg-012'
 *   }, state)
 * ];
 */
export function updateStateFacets(
  baseId: string,
  updates: Record<string, any>,
  currentState?: any
): any[] {
  const deltas: any[] = [];
  
  for (const [key, newValue] of Object.entries(updates)) {
    const facetId = `${baseId}-${key}`;
    
    // Check if facet exists
    const existingFacet = currentState?.facets?.get(facetId);
    
    if (existingFacet) {
      // Rewrite existing state facet
      deltas.push({
        type: 'rewriteFacet',
        id: facetId,
        changes: {
          state: { value: newValue }
        }
      });
    } else {
      // Create new state facet (persistent, no content = not rendered)
      // This is simpler than the state-change → internal-state flow
      deltas.push({
        type: 'addFacet',
        facet: {
          id: facetId,
          type: 'state',
          // No content - internal tracking state, not conversational content
          state: { value: newValue }
        }
      });
    }
  }
  
  return deltas;
}
