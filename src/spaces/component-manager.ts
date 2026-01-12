import { Component } from './component';
import { ExecutionContext } from './types';
import { SpaceEvent } from './component-types';
import { ReadonlyVEILState, ReadonlyFrame } from '../veil/types';
import { ComponentRegistry } from '../persistence/component-registry';
import { createComponentStateFacet } from '../helpers/factories';
import { join, dirname } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { ComponentStateFacet } from '../veil/facet-types';
import { priorityConstraint } from './constraints';

/**
 * ComponentManager: Unified component lifecycle management
 *
 * FLEX Component (constraint: priority 50 - Early infrastructure)
 *
 * Handles the complete component lifecycle:
 * 1. Receives component:add events → creates component-state facets with constraints
 * 2. Instantiates components from facets (both fresh and restored)
 * 3. Handles component:remove events → removes components
 *
 * This maintains VEIL as the single source of truth for component lifecycle.
 * Both fresh starts and restoration work the same way: facets → components.
 */
export class ComponentManager extends Component {
  // Runs early so instantiated components can participate in current frame
  constraints = [priorityConstraint(50)];

  // Track which component-state facets we've already instantiated
  private instantiatedComponents = new Set<string>();

  execute(context: ExecutionContext): void {
    const { event, frame, state } = context;
    if (!frame) return;

    // Handle component:add events - create facet first
    if (event.topic === 'component:add') {
      this.handleComponentAdd(event, state);
    }

    // Process all pending component instantiations
    this.processComponents(frame, state).catch(err => {
      console.error('[ComponentManager] Error processing components:', err);
    });

    // Handle component:remove events
    if (event.topic === 'component:remove') {
      this.handleComponentRemove(event);
    }
  }

  /**
   * Handle component:add event - create component-state facet with constraints
   */
  private handleComponentAdd(event: SpaceEvent, state: ReadonlyVEILState): void {
    const payload = event.payload as any;
    const componentType = payload.componentType || payload.type;
    const config = payload.config || {};

    if (!componentType) {
      console.warn('[ComponentManager] component:add event missing componentType', payload);
      return;
    }

    // Generate component ID
    let componentId = payload.componentId;
    const parentId = payload.parentId || payload.componentId;
    if (!componentId && parentId) {
      if (parentId !== 'root') {
        componentId = `${parentId}:${componentType}`;
      }
    }
    if (!componentId) {
      componentId = `${componentType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // Check if component-state facet already exists (idempotency)
    const facetId = `component-state:${componentId}`;
    if (state.facets.has(facetId)) {
      console.log(`[ComponentManager] Component-state facet already exists: ${facetId}`);
      return;
    }

    console.log(`[ComponentManager] Creating component-state facet for ${componentType} (${componentId})`);

    // Create component-state facet with nested constraints
    const facet = createComponentStateFacet({
      componentId,
      componentType,
      parentId: parentId || 'root',
      initialState: config,
      constraints: payload.priority !== undefined
        ? [priorityConstraint(payload.priority)]
        : undefined
    });

    // Add facet to VEIL state via Space
    if ('applyOperation' in this.space) {
      (this.space as any).applyOperation({
        type: 'addFacet',
        facet
      });
    } else {
      console.error('[ComponentManager] Space does not support applyOperation - cannot create facet');
    }
  }

  private async processComponents(frame: ReadonlyFrame, state: ReadonlyVEILState): Promise<void> {
    const events: SpaceEvent[] = [];

    // Find all component-state facets that need instantiation
    for (const [facetId, facet] of state.facets) {
      if (facet.type === 'component-state' && !this.instantiatedComponents.has(facetId)) {
        await this.instantiateComponent(facet as ComponentStateFacet, events);
      }
    }

    // Emit collected events directly via space (async processing)
    for (const event of events) {
      this.space.emit(event);
    }
  }

  // Infrastructure components that should not be instantiated by ComponentManager
  private static readonly INFRASTRUCTURE_TYPES = new Set([
    'ComponentManager',
    'PersistenceManager',
    'VEILOperationReceptor',
    'HostHandlerComponent'
  ]);

  /**
   * Instantiate a component from its component-state facet
   */
  private async instantiateComponent(facet: ComponentStateFacet, events: SpaceEvent[]): Promise<void> {
    const { componentId, componentType, state: config } = facet;
    const facetId = `component-state:${componentId}`;

    // Skip infrastructure components
    if (ComponentManager.INFRASTRUCTURE_TYPES.has(componentType)) {
      this.instantiatedComponents.add(facetId);
      return;
    }

    console.log(`[ComponentManager] Instantiating component ${componentType} (${componentId}) from facet`);

    // Check if component already exists in Space (idempotency)
    const existing = this.space.getComponentById(componentId);
    if (existing) {
      console.log(`[ComponentManager] Component already exists in Space: ${componentId}`);
      this.instantiatedComponents.add(facetId);
      return;
    }

    // AXON loading logic
    const axonMetadata = (config as any)?._axonMetadata;
    if (axonMetadata?.moduleUrl && !ComponentRegistry.has(componentType)) {
      try {
        await this.loadAndRegisterAxonComponent(componentType, axonMetadata);
      } catch (error) {
        console.error(`[ComponentManager] Failed to load AXON component ${componentType}:`, error);
        return;
      }
    }

    // Get component class from registry
    let ComponentClass = ComponentRegistry.getConstructor(componentType);

    if (!ComponentClass) {
      // Try to create from registry (it might have create method)
      try {
        const instance = ComponentRegistry.create(componentType);
        if (instance) {
          ComponentClass = instance.constructor as any;
        }
      } catch (e) {}
    }

    if (!ComponentClass && !ComponentRegistry.create(componentType)) {
      console.error(`[ComponentManager] Unknown component type: ${componentType}`);
      this.instantiatedComponents.add(facetId); // Mark as processed to avoid retries
      return;
    }

    try {
      // Create component instance
      const component = ComponentRegistry.create(componentType) || new (ComponentClass as any)();

      // Apply config from facet state
      if (config && typeof config === 'object') {
        Object.assign(component, config);

        // Handle AXON afferents with setConnectionParams
        if (axonMetadata && 'setConnectionParams' in component && typeof (component as any).setConnectionParams === 'function') {
          // Async init - catch errors
          (component as any).setConnectionParams(config).catch((err: any) => {
            console.error(`[ComponentManager] Error configuring ${componentType}:`, err);
          });
        }
      }

      // Add to space - component class already has its constraints defined,
      // no need to inject from facet. VEIL facet constraints are just persisted
      // copies for inspection/debugging, not the source of truth.
      this.space.addComponent(component, componentId, true);

      // Mark as instantiated
      this.instantiatedComponents.add(facetId);

      // Emit component:mounted event
      events.push({
        topic: 'component:mounted',
        source: this.space.getRef(),
        payload: {
          componentId: component.id,
          componentType,
          config
        },
        timestamp: Date.now()
      });

      console.log(`[ComponentManager] Component instantiated: ${componentType} (${componentId})`);

    } catch (error) {
      console.error(`[ComponentManager] Failed to instantiate component ${componentType}:`, error);
      this.instantiatedComponents.add(facetId); // Mark as processed to avoid infinite retries
    }
  }

  private handleComponentRemove(event: SpaceEvent): void {
     const payload = event.payload as any;
     const { componentId } = payload;

     if (componentId) {
       const component = this.space.getComponentById(componentId);
       if (component) {
         this.space.removeComponent(component);
         console.log(`[ComponentManager] Removed component ${componentId}`);
       } else {
         console.warn(`[ComponentManager] Component to remove not found: ${componentId}`);
       }
     }
  }

  /**
   * Load and register an AXON component from a module URL
   */
  private async loadAndRegisterAxonComponent(componentType: string, axonMetadata: any): Promise<void> {
    const { moduleUrl } = axonMetadata;

    try {
      // Fetch module code
      const response = await fetch(moduleUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const moduleCode = await response.text();

      // Create module environment similar to AxonLoader
      const { createAxonEnvironment } = require('../axon/environment');
      const env = createAxonEnvironment();

      // Write module to temp file for proper Node.js module loading
      const Module = require('module');

      const tempFile = join(tmpdir(), `connectome-axon-${componentType}-${Date.now()}.js`);
      writeFileSync(tempFile, moduleCode);

      // Clear module cache to force reload
      delete require.cache[tempFile];

      // Create a module with proper paths for resolution
      const axonModule = new Module(tempFile);
      axonModule.filename = tempFile;
      axonModule.paths = Module._nodeModulePaths(dirname(tempFile));

      // Add connectome-ts parent directory to module paths
      const connectomeParentPath = join(__dirname, '../../..');
      axonModule.paths.unshift(connectomeParentPath);

      // Load module
      axonModule._compile(moduleCode, tempFile);
      const module: { exports: any } = { exports: axonModule.exports };

      // Clean up temp file after a delay
      setTimeout(() => {
        try {
          delete require.cache[tempFile];
          unlinkSync(tempFile);
        } catch (e) {}
      }, 1000);

      // Get module exports
      const moduleExports = module.exports as any;

      // Handle AXON module format: { components: { Name: Class, ... } }
      let ComponentClass;
      let moduleExportsObject;

      if (typeof moduleExports.createModule === 'function') {
        moduleExportsObject = moduleExports.createModule(env);

        // Look for the requested component type in the components object
        if (moduleExportsObject.components && typeof moduleExportsObject.components === 'object') {
          ComponentClass = moduleExportsObject.components[componentType];

          // If not found by exact name, try to find it
          if (!ComponentClass) {
            // Search by class name
            for (const [name, cls] of Object.entries(moduleExportsObject.components)) {
              if ((cls as any).name === componentType || name === componentType) {
                ComponentClass = cls;
                break;
              }
            }
          }

          // Register and instantiate all components from the module
          for (const [name, cls] of Object.entries(moduleExportsObject.components)) {
            if (typeof cls === 'function') {
              const className = (cls as any).name || name;
              if (!ComponentRegistry.has(className)) {
                ComponentRegistry.register(className, cls as any);
              }

              // Instantiate auxiliary components (not the main requested one)
              if (className !== componentType) {
                const existingComponent = this.space.getComponentById(`component:${className}`);
                if (!existingComponent) {
                  try {
                    const auxComponent = new (cls as any)();
                    this.space.addComponent(auxComponent, `component:${className}`);
                    console.log(`[ComponentManager] Instantiated auxiliary component: ${className}`);
                  } catch (err) {
                    console.error(`[ComponentManager] Failed to instantiate auxiliary component ${className}:`, err);
                  }
                }
              }
            }
          }
        }
      }

      if (typeof ComponentClass === 'function') {
        // Register with ComponentRegistry if not already
        if (!ComponentRegistry.has(componentType)) {
          ComponentRegistry.register(componentType, ComponentClass);
        }
      } else {
        throw new Error(`Module did not export component '${componentType}' in components object`);
      }
    } catch (error) {
      console.error(`[ComponentManager] Failed to load AXON component ${componentType}:`, error);
      throw error;
    }
  }
}
