/**
 * Restoration system for bringing persisted state back to life
 */

import { VEILStateManager } from '../veil/veil-state';
import { VEILState, Facet, StreamInfo } from '../veil/types';
import { Space } from '../spaces/space';
import { Component } from '../spaces/component';
import {
  SerializedVEILState,
  SerializedComponent,
  PersistenceSnapshot,
  SerializedSpace
} from './types';
import { deserializeValue } from './serialization';
import { ComponentRegistry } from './component-registry';

/**
 * Restore VEIL state from serialized format
 */
export async function restoreVEILState(
  veilManager: VEILStateManager,
  serialized: SerializedVEILState
): Promise<void> {
  // Create a new state object
  const newState: VEILState = {
    facets: new Map(),
    scopes: new Set(serialized.scopes),
    streams: new Map(),
    currentStream: serialized.currentStream ? 
      deserializeValue(serialized.currentStream) : undefined,
    frameHistory: serialized.frameHistory ? 
      serialized.frameHistory.map(f => deserializeValue(f)) : [],
    currentSequence: serialized.currentSequence,  // Use serialized sequence
    removals: new Map(serialized.removals || []),
    agents: new Map(),
    currentAgent: undefined,
    currentStateCache: new Map()  // Will be rebuilt from facets
  };
  
  // Add facet to the Map - children stay nested, not flattened to top-level
  // This prevents orphaned children when parent facets are removed, and
  // eliminates data duplication/inconsistency between nested and flattened copies
  const addFacet = (facet: any) => {
    newState.facets.set(facet.id, facet);
    // Children remain nested in facet.children - no flattening
  };
  
  // Restore facets
  for (const [id, facetData] of serialized.facets) {
    const facet = deserializeFacet(facetData);
    if (facet) {
      addFacet(facet);
    }
  }
  
  // Restore streams
  for (const [id, streamData] of serialized.streams) {
    const stream = deserializeValue(streamData) as StreamInfo;
    newState.streams.set(id, stream);
  }
  
  // Apply the restored state
  veilManager.setState(newState);
  
  console.log(`[Restoration] Restored ${newState.facets.size} facets, ${newState.frameHistory.length} frames`);
  
  // Rebuild state cache from facets and state-changes
  (veilManager as any).rebuildStateCache();
}

/**
 * Deserialize a facet
 */
function deserializeFacet(data: any): Facet | null {
  try {
    const base: any = {
      id: data.id,
      type: data.type,
      displayName: data.displayName,
      scope: data.scope,
      saliency: data.saliency
    };
    
    // Restore optional properties
    if (data.content) {
      base.content = data.content;
    }
    
    if (data.attributes) {
      base.attributes = deserializeValue(data.attributes);
    }
    
    if (data.children) {
      base.children = data.children.map((child: any) => deserializeFacet(child)).filter(Boolean);
    }
    
    // Handle type-specific fields
    switch (data.type) {
      case 'state':
        if (data.initialValue !== undefined) {
          base.initialValue = deserializeValue(data.initialValue);
        }
        if (data.transitionRenderers) {
          base.transitionRenderers = data.transitionRenderers;
        }
        break;

      case 'component-state':
        if (data.componentType) base.componentType = data.componentType;
        if (data.componentId) base.componentId = data.componentId;
        if (data.parentId) base.parentId = data.parentId;
        break;

      case 'tool':
        if (data.toolName) base.toolName = data.toolName;
        if (data.parameters) base.parameters = deserializeValue(data.parameters);
        break;

      case 'action':
        if (data.actionTarget) base.actionTarget = data.actionTarget;
        if (data.actionName) base.actionName = data.actionName;
        if (data.parameters) base.parameters = deserializeValue(data.parameters);
        break;

      case 'script-execution':
        // Restore script execution fields
        if (data.code) base.code = data.code;
        if (data.timeoutMs !== undefined) base.timeoutMs = data.timeoutMs;
        if (data.parentScriptId !== undefined) base.parentScriptId = data.parentScriptId;
        if (data.blockedOn) base.blockedOn = data.blockedOn;

        // Mark running/blocked scripts as interrupted on restore
        // Scripts cannot be resumed after restart since Lua state is lost
        if (data.status === 'running' || data.status === 'blocked' || data.status === 'pending') {
          base.status = 'error';
          console.log(`[Restoration] Marking script ${data.id} as interrupted (was ${data.status})`);
        } else {
          base.status = data.status;
        }
        break;

      case 'tool-call':
        // Restore tool call fields
        if (data.parentScriptId) base.parentScriptId = data.parentScriptId;
        if (data.toolName) base.toolName = data.toolName;
        if (data.args) base.args = deserializeValue(data.args);

        // Mark pending/running tool calls as error on restore
        if (data.status === 'running' || data.status === 'pending') {
          base.status = 'error';
          console.log(`[Restoration] Marking tool-call ${data.id} as interrupted (was ${data.status})`);
        } else {
          base.status = data.status;
        }
        break;
    }
    
    // Restore state aspect (for all facets that have it, not just type='state')
    if (data.state) {
      base.state = deserializeValue(data.state);
    }
    
    // Restore stream aspect
    if (data.streamId) {
      base.streamId = data.streamId;
      if (data.streamType) base.streamType = data.streamType;
    }
    
    // Restore agent aspect
    if (data.agentId) {
      base.agentId = data.agentId;
      if (data.agentName) base.agentName = data.agentName;
    }
    
    return base as Facet;
  } catch (error) {
    console.error('Failed to deserialize facet:', error);
    return null;
  }
}

/**
 * Restore a component from serialized data
 */
export async function restoreComponent(data: SerializedComponent): Promise<Component | null> {
  // Create component instance
  const component = ComponentRegistry.create(data.className);
  if (!component) {
    // Make this a fatal error - components must be registered for restoration
    throw new Error(`Component class not found in registry: ${data.className}. Please ensure it's registered in the application's getComponentRegistry() method.`);
  }
  
  // Restore persistent properties
  if (data.properties) {
    // Get persistence metadata for the component
    const metadata = (component.constructor as any).getPersistenceMetadata?.();
    
    if (metadata?.properties) {
      // Properly deserialize each property using its serializer
      for (const [key, value] of Object.entries(data.properties)) {
        const propertyMetadata = metadata.properties.get(key);
        if (propertyMetadata?.serializer?.deserialize) {
          // Use the deserializer for this property
          (component as any)[key] = propertyMetadata.serializer.deserialize(value);
        } else {
          // No custom serializer, use direct assignment
          (component as any)[key] = value;
        }
      }
    } else {
      // Fallback to direct assignment if no metadata
      console.warn(`[Restoration] No persistence metadata for ${data.className}, using direct assignment`);
      Object.assign(component, data.properties);
    }
  }
  
  return component;
}

/**
 * Restore Space and its components
 */
export async function restoreSpace(space: Space, serialized: SerializedSpace): Promise<void> {
  console.log(`[Restoration] Restoring space ${serialized.id}`);

  // Support both new format (components) and legacy format (children)
  const componentsData = serialized.components || (serialized as any).children;
  if (!componentsData) {
    console.warn('[Restoration] No components or children found in serialized space');
    return;
  }

  if ((serialized as any).children && !serialized.components) {
    console.warn('⚠️  [Restoration] DEPRECATED: Space uses legacy "children" field instead of "components"');
    console.warn('    This will be automatically migrated on next snapshot save.');
  }

  // Restore components
  for (const componentData of componentsData) {
    try {
      const component = await restoreComponent(componentData);
      if (component) {
        // Use component ID from serialization if available
        const componentId = componentData.id || `restored-component-${Date.now()}`;
        
        // Add to space (this will trigger mount/restore)
        space.addComponent(component, componentId, true);
        console.log(`[Restoration] Restored component: ${component.constructor.name} (${componentId})`);
      }
    } catch (error) {
      console.error(`[Restoration] Failed to restore component:`, error);
    }
  }
}

/**
 * Full restoration from a persistence snapshot
 */
export async function restoreFromSnapshot(
  space: Space,
  veilManager: VEILStateManager,
  snapshot: PersistenceSnapshot
): Promise<void> {
  console.log(`Restoring from snapshot version ${snapshot.version} at sequence ${snapshot.sequence}`);
  
  // Step 1: Restore VEIL state
  await restoreVEILState(veilManager, snapshot.veilState);

  // Step 2: Restore Space (replaces element tree restoration)
  // Support both new format (space) and legacy format (elementTree)
  const spaceData = snapshot.space || (snapshot as any).elementTree;
  if (spaceData) {
    if ((snapshot as any).elementTree && !snapshot.space) {
      console.warn('⚠️  [Restoration] DEPRECATED: Loading from legacy "elementTree" format');
      console.warn('    Please resave this snapshot to migrate to the new "space" format.');
    }
    await restoreSpace(space, spaceData);
  } else {
    console.warn('[Restoration] No space or elementTree found in snapshot');
  }
  
  // Step 3: TODO - Restore compressed frame batches if present
  if (snapshot.compressedFrames) {
    console.log('Compressed frame restoration not yet implemented');
  }
  
  console.log('Restoration complete');
}
