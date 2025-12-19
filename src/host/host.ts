/**
 * ConnectomeHost - Core infrastructure for Connectome applications
 */

import { Space } from '../spaces/space';
import { VEILStateManager } from '../veil/veil-state';
import { TransitionManager } from '../persistence/transition-manager';
import { PersistenceMaintainer } from '../persistence/persistence-maintainer';
import { FileStorageAdapter } from '../persistence/file-storage';
import { DebugServer } from '../debug/debug-server';
import { LLMProvider } from '../llm/llm-interface';
import { ComponentRegistry } from '../persistence/component-registry';
import { ConnectomeApplication } from './types';
import { getReferenceMetadata, getExternalMetadata, RestorableComponent } from './decorators';
import { Component } from '../spaces/component';
import { SpaceEvent } from '../spaces/types';
import { restoreVEILState } from '../persistence/restoration';
import { registerDebugHost, registerDebugSpace, registerDebugServer } from '../debug/debug-registry';

export interface HostConfig {
  persistence?: {
    enabled: boolean;
    storageDir?: string;
    snapshotInterval?: number;  // Frames between snapshots (default: 100)
  };
  debug?: {
    enabled: boolean;
    port?: number;
  };
  providers?: {
    [key: string]: LLMProvider;
  };
  secrets?: {
    [key: string]: string;
  };
  reset?: boolean;
}

/**
 * Component to handle dynamic component loading events
 */
class HostHandlerComponent extends Component {
  private host: ConnectomeHost;

  constructor(host: ConnectomeHost) {
    super();
    this.host = host;
  }

  onMount(): void {
    console.log('[Host Handler] Mounted and ready to handle dynamic component events');
  }

  async handleEvent(event: SpaceEvent): Promise<void> {
    console.log(`[Host Handler] Received event: ${event.topic}`);
    if (event.topic === 'axon:component-loaded') {
      const payload = event.payload as { component: Component; componentType: string };
      const component = payload.component;
      if (component) {
        console.log(`🔌 Resolving references for dynamically loaded component: ${payload.componentType}`);
        await this.host.resolveComponentReferences(component);
        await this.host.resolveExternalResources(component);

        // Call onReferencesResolved if it exists
        if ('onReferencesResolved' in component && typeof (component as any).onReferencesResolved === 'function') {
          (component as any).onReferencesResolved();
        }
      }
    }
  }
}

export class ConnectomeHost {
  private config: HostConfig;
  private referenceRegistry = new Map<string, any>();
  private providers = new Map<string, LLMProvider>();
  private secrets = new Map<string, string>();
  private transitionManager?: TransitionManager;
  private storageAdapter?: any;  // FileStorageAdapter instance
  private debugServer?: DebugServer;
  
  constructor(config: HostConfig = {}) {
    this.config = config;

    // Register for debug access (only when --inspect is active)
    registerDebugHost(this);

    // Register providers
    if (config.providers) {
      Object.entries(config.providers).forEach(([id, provider]) => {
        this.providers.set(id, provider);
        this.referenceRegistry.set(`provider:${id}`, provider);

        // Also register common names for convenience
        if (id === 'llm.primary') {
          this.referenceRegistry.set('llmProvider', provider);
        }
      });
    }

    // Register secrets
    if (config.secrets) {
      Object.entries(config.secrets).forEach(([id, secret]) => {
        this.secrets.set(id, secret);
        console.log(`[Host] Registered secret: ${id} = ${secret ? '***' + secret.slice(-4) : 'undefined'}`);
      });
    }
  }
  
  /**
   * Start a Connectome application
   */
  async start(app: ConnectomeApplication): Promise<Space> {
    console.log('🚀 Starting Connectome Host...');
    
    // Handle storage initialization and reset
    if (this.config.persistence?.enabled) {
      const storageDir = this.config.persistence.storageDir || './connectome-state';
      this.storageAdapter = new FileStorageAdapter(storageDir);
      
      // Clear storage on --reset to start completely fresh
      if (this.config.reset) {
        console.log('🗑️  Clearing persistence storage (--reset flag)...');
        await this.storageAdapter.clear();
        console.log('✅ Storage cleared - starting fresh lifecycle');
      }
    }
    
    let space: Space;
    let veilState: VEILStateManager;
    let wasRestored = false;
    
    try {
      // Check for existing snapshot
      const snapshot = await this.loadSnapshot();
      
      if (snapshot && !this.config.reset) {
        console.log('📦 Restoring from snapshot...');
        ({ space, veilState } = await this.restore(snapshot, app));
        wasRestored = true;
      } else {
        console.log('🌱 Creating fresh application...');
        ({ space, veilState } = await this.createFresh(app));
      }
    } catch (error) {
      // If persistence is enabled and loading failed, this is a fatal error
      if (this.config.persistence?.enabled && !this.config.reset) {
        console.error('❌ Failed to load persisted state:', error);
        console.error('💥 Persistence loading failed - exiting to prevent data loss');
        throw error;
      }
      // If persistence is not enabled, we can continue with fresh state
      console.log('🌱 Creating fresh application...');
      ({ space, veilState } = await this.createFresh(app));
    }
    
    // Core services already registered in createFresh/restore

    // Register space for debug access (only when --inspect is active)
    registerDebugSpace(space);

    // Set up persistence tracking if enabled
    if (this.config.persistence?.enabled) {
      // Create storage adapter (reused for loading deltas)
      this.storageAdapter = new (await import('../persistence/file-storage')).FileStorageAdapter(
        this.config.persistence.storageDir || './connectome-state'
      );

      // Mount persistence maintainer (auto-registration handles the rest!)
      const persistenceMaintainer = new PersistenceMaintainer(veilState, space, {
        storagePath: this.config.persistence.storageDir || './connectome-state',
        snapshotInterval: this.config.persistence.snapshotInterval || 100
      });

      // Mount directly
      space.addComponent(persistenceMaintainer, 'infrastructure:PersistenceMaintainer');

      // Store reference for debug server frame deletion
      (space as any).persistence = persistenceMaintainer;
    }

    // Debug server already started in createFresh() if enabled
    if (this.debugServer) {
      console.log(`🔍 Debug UI available at http://localhost:${this.config.debug?.port || 3015}`);
    }

    // Set up dynamic component handler
    this.setupDynamicComponentHandler(space);
    
    // Let the application perform final initialization
    // Only call onStart for fresh applications (not after restore)
    if (!wasRestored) {
      await app.onStart?.(space, veilState);
    }
    
    console.log('✅ Host started successfully!\n');
    
    return space;
  }
  
  /**
   * Stop the host and clean up resources
   */
  async stop(): Promise<void> {
    // Save final snapshot
    console.log('\n💾 Saving state before shutdown...');
    if (this.transitionManager) {
      await this.transitionManager.createSnapshot();
    }
    
    // Stop debug server
    if (this.debugServer) {
      this.debugServer.stop();
    }
    
    // Clear registries
    this.referenceRegistry.clear();
    this.providers.clear();
    this.secrets.clear();
  }
  
  /**
   * Delete recent frames
   */
  async deleteFrames(count: number): Promise<void> {
    if (!this.transitionManager) {
      throw new Error('Persistence not enabled');
    }
    
    await this.transitionManager.deleteRecentFramesAndSnapshot(count, 'User requested deletion');
  }
  
  /**
   * Create a fresh application instance
   */
  private async createFresh(app: ConnectomeApplication): Promise<{ space: Space; veilState: VEILStateManager }> {
    const { space, veilState } = await app.createSpace(this.referenceRegistry);

    // Register core services before initialization
    this.referenceRegistry.set('space', space);
    this.referenceRegistry.set('veilState', veilState);

    // Initialize core infrastructure BEFORE app.initialize()
    await this.initializeComponentInfrastructure(space);

    // Attach debug server BEFORE app.initialize() so it captures all frames
    if (this.config.debug?.enabled) {
      const port = this.config.debug.port || 3015;
      this.debugServer = new DebugServer(space, { port });
      registerDebugServer(this.debugServer);
      await this.debugServer.start();
      console.log(`🔍 Debug UI will capture all frames from initialization`);
    }

    await app.initialize(space, veilState);
    await this.resolveAllReferences(space);
    return { space, veilState };
  }
  
  /**
   * Restore from a persistence snapshot
   */
  private async restore(snapshot: any, app: ConnectomeApplication): Promise<{ space: Space; veilState: VEILStateManager }> {
    console.log('[Host.restore] Starting restoration...');

    // Create space and VEIL state, preserving lifecycleId and spaceId from snapshot
    const { space, veilState } = await app.createSpace(this.referenceRegistry, snapshot.lifecycleId, snapshot.spaceId);
    console.log('[Host.restore] Space created');

    // Register core services before restoration
    this.referenceRegistry.set('space', space);
    this.referenceRegistry.set('veilState', veilState);

    // Register components with ComponentRegistry BEFORE restoration
    app.getComponentRegistry();
    console.log('[Host.restore] ComponentRegistry populated');

    // Enter restoration mode BEFORE any component initialization
    space.setRestorationMode(true);

    // Restore VEIL state from snapshot
    console.log('[Host.restore] Restoring VEIL state...');
    await restoreVEILState(veilState, snapshot.veilState);
    console.log('[Host.restore] VEIL state restored');

    // NOW initialize infrastructure (after VEIL is restored)
    console.log('[Host.restore] Initializing infrastructure...');
    await this.initializeComponentInfrastructure(space);
    console.log('[Host.restore] Infrastructure initialized');

    // Start debug server during restore as well
    if (this.config.debug?.enabled && !this.debugServer) {
      const port = this.config.debug.port || 3015;
      this.debugServer = new DebugServer(space, { port });
      registerDebugServer(this.debugServer);
      await this.debugServer.start();
      console.log(`🔍 Debug server started during restore`);
    }

    // Set up dynamic component handler BEFORE restoring components
    this.setupDynamicComponentHandler(space);

    const afterTreeState = veilState.getState();
    console.log(`[Host.restore] After VEIL restore: currentSeq=${afterTreeState.currentSequence}, frameCount=${afterTreeState.frameHistory.length}, facets=${afterTreeState.facets.size}`);

    // Log facet types for debugging
    const facetTypes = new Map<string, number>();
    for (const [id, facet] of afterTreeState.facets) {
      const count = facetTypes.get(facet.type) || 0;
      facetTypes.set(facet.type, count + 1);
    }
    console.log('[Host.restore] Facet types:', Object.fromEntries(facetTypes));

    // Load and replay deltas since the snapshot
    if (this.config.persistence?.enabled && this.storageAdapter) {
      const deltas = await this.storageAdapter.loadDeltas(
        snapshot.sequence + 1,
        undefined,
        snapshot.lifecycleId
      );

      if (deltas.length > 0) {
        console.log(`📼 Replaying ${deltas.length} deltas since snapshot (sequence ${snapshot.sequence})...`);

        // Replay each delta frame synchronously to VEIL
        for (const delta of deltas) {
          const changes = veilState.applyFrame(delta.frame);
        }

        const finalSequence = veilState.getState().currentSequence;
        console.log(`✅ Replayed deltas, now at sequence ${finalSequence}`);
      }
    }

    // Reconstruct components from VEIL facets
    console.log('[Host.restore] Reconstructing components from VEIL...');
    await this.reconstructComponentsFromVEIL(space, veilState);
    console.log('[Host.restore] Components reconstructed');

    // Exit restoration mode
    space.setRestorationMode(false);

    console.log('✅ All components restored and mounted');
    
    // Now resolve all references and external resources
    await this.resolveAllReferences(space);
    
    // Check for any dynamically loaded components that need resources resolved
    await this.resolveDynamicComponents(space);
    
    // Complete mounting for all restored components
    console.log('🔧 Completing component mounting after restoration...');
    await space.completeMountForRestoration();
    
    // Let app do any post-restore setup
    await app.onRestore?.(space, veilState);
    
    return { space, veilState };
  }
  
  /**
   * Load persistence snapshot if available
   */
  private async loadSnapshot(): Promise<any | null> {
    if (!this.storageAdapter) return null;
    
    try {
      const snapshots = await this.storageAdapter.listSnapshots();
      if (snapshots.length === 0) return null;
      
      console.log(`[Host] Found ${snapshots.length} snapshots, selecting newest:`);
      console.log(`[Host] Loading snapshot: ${snapshots[snapshots.length - 1]}`);
      
      const latest = snapshots[snapshots.length - 1];
      const snapshot = await this.storageAdapter.loadSnapshot(latest);
      
      if (!snapshot) {
        throw new Error(`Failed to load snapshot ${latest}: Invalid snapshot structure`);
      }
      
      return snapshot;
    } catch (error) {
      console.error('Failed to load snapshot:', error);
      throw error;
    }
  }
  
  /**
   * Initialize core Component infrastructure
   */
  private async initializeComponentInfrastructure(space: Space): Promise<void> {
    const { ComponentManager } = await import('../spaces/component-manager');

    console.log('✨ Connectome host initialized with FLEX component architecture');

    // Mount ComponentManager (priority 50) - handles component:add events and instantiation
    const componentManager = new ComponentManager();
    space.addComponent(componentManager, 'infrastructure:ComponentManager');

    console.log('🔧 Component infrastructure initialized');
  }

  /**
   * Resolve all component references and external resources
   */
  private async resolveAllReferences(space: Space): Promise<void> {
    const components = space.components;
    
    // First pass: resolve references
    for (const component of components) {
      await this.resolveComponentReferences(component);
    }
    
    // Second pass: resolve external resources
    for (const component of components) {
      await this.resolveExternalResources(component);
    }
    
    // Third pass: notify components
    for (const component of components) {
      const restorable = component as RestorableComponent;
      if (restorable.onReferencesResolved) {
        await restorable.onReferencesResolved();
      }
    }
  }
  
  /**
   * Resolve references for a component
   */
  public async resolveComponentReferences(component: Component): Promise<void> {
    const references = getReferenceMetadata(component);
    
    for (const ref of references) {
      const target = this.referenceRegistry.get(ref.referenceId!);
      
      if (!target && ref.required) {
        throw new Error(`Required reference '${ref.referenceId}' not found for ${component.constructor.name}`);
      }
      
      if (target) {
        (component as any)[ref.propertyKey] = target;
      }
    }
  }
  
  /**
   * Resolve external resources for a component
   */
  public async resolveExternalResources(component: Component): Promise<void> {
    const externals = getExternalMetadata(component);
    
    if (externals.length > 0) {
      console.log(`Resolving ${externals.length} external resources for ${component.constructor.name}`);
    }
    
    for (const ext of externals) {
      const [type, ...pathParts] = ext.resourcePath.split(':');
      const path = pathParts.join(':');
      
      let value: any;
      
      switch (type) {
        case 'secret':
          value = this.secrets.get(path);
          break;
        case 'provider':
          value = this.providers.get(path);
          break;
        default:
          throw new Error(`Unknown external resource type: ${type}`);
      }
      
      if (!value && ext.required) {
        throw new Error(`Required external resource '${ext.resourcePath}' not found for ${component.constructor.name}`);
      }
      
      if (value) {
        (component as any)[ext.propertyKey] = value;
      }
    }
  }
  
  /**
   * Resolve resources for any dynamically loaded components
   */
  private async resolveDynamicComponents(space: Space): Promise<void> {
    console.log('[Host] Checking for dynamically loaded components needing resources...');
    
    for (const component of space.components) {
      // Special handling for AxonLoader - check if it has a loaded component
      if (component.constructor.name === 'AxonLoaderComponent') {
        const axonLoader = component as any;
        if (axonLoader.loadedComponent) {
          // Resolve resources for loaded component
          await this.resolveComponentReferences(axonLoader.loadedComponent);
          await this.resolveExternalResources(axonLoader.loadedComponent);
          
          if ('onReferencesResolved' in axonLoader.loadedComponent && 
              typeof axonLoader.loadedComponent.onReferencesResolved === 'function') {
            axonLoader.loadedComponent.onReferencesResolved();
          }
        }
      }
      
      // Standard resolution
      await this.resolveComponentReferences(component);
      await this.resolveExternalResources(component);
    }
  }
  
  /**
   * Set up handler for dynamically loaded components
   */
  private setupDynamicComponentHandler(space: Space): void {
    const componentId = '_host_handler:HostHandlerComponent';
    const existingHandler = space.getComponentById(componentId);

    if (existingHandler) {
      console.log('[Host] Found existing host handler from persistence');
      // Ensure space is subscribed to the right events
      space.subscribe('axon:component-loaded');
      return;
    }

    // Create new host handler component
    console.log('[Host] Creating new host handler');
    const handler = new HostHandlerComponent(this);

    // Mount directly
    space.addComponent(handler, componentId);

    // Subscribe to axon component loaded events at space level
    space.subscribe('axon:component-loaded');

    console.log('[Host] Dynamic component handler setup complete');
  }
  
  /**
   * Reconstruct components from component-state facets in VEIL
   */
  private async reconstructComponentsFromVEIL(space: Space, veilState: VEILStateManager): Promise<void> {
    const { ComponentRegistry } = await import('../persistence/component-registry');
    const state = veilState.getState();

    // Find all component-state facets
    const componentFacets = Array.from(state.facets.values())
      .filter(f => f.type === 'component-state') as any[];

    if (componentFacets.length === 0) {
      console.log('[Host] No component-state facets found in VEIL state');
      return;
    }

    // Infrastructure components that are added by the host/space separately
    // These should not be restored from facets
    const infrastructureTypes = new Set([
      'ComponentManager',
      'PersistenceMaintainer',
      'VEILOperationReceptor',
      'HostHandlerComponent'
    ]);

    console.log(`[Host] Reconstructing ${componentFacets.length} components from VEIL facets...`);

    for (const facet of componentFacets) {
      const { componentId, componentType } = facet;
      const config = facet.state || {};

      if (!componentId || !componentType) {
        console.warn(`[Host] Facet missing componentId/componentType: ${facet.id}`);
        continue;
      }

      // Skip infrastructure components - they're added by the host
      if (infrastructureTypes.has(componentType)) {
        console.log(`[Host]   Skipping infrastructure component: ${componentType} (${componentId})`);
        continue;
      }

      // Skip if component already exists
      const existing = space.getComponentById(componentId);
      if (existing) {
        console.log(`[Host]   Skipping existing component: ${componentType} (${componentId})`);
        continue;
      }

      // Check for AXON metadata - load dynamically if needed
      const axonMetadata = (config as any)?._axonMetadata;
      console.log(`[Host]   ${componentType}: config keys=${Object.keys(config).join(',')}, axonMetadata=${!!axonMetadata}`);
      if (axonMetadata?.moduleUrl && !ComponentRegistry.has(componentType)) {
        console.log(`[Host]   Loading AXON component: ${componentType} from ${axonMetadata.moduleUrl}`);
        try {
          await this.loadAxonComponent(componentType, axonMetadata);
        } catch (error) {
          console.error(`[Host] Failed to load AXON component ${componentType}:`, error);
          continue;
        }
      }

      // Create component using registry
      const component = ComponentRegistry.create(componentType);

      if (!component) {
        console.warn(`[Host] Component type not in registry: ${componentType} (${componentId})`);
        continue;
      }

      // Apply config properties to component
      if (config && typeof config === 'object') {
        Object.assign(component, config);

        // For AXON afferents, call setConnectionParams to trigger initialization
        if (axonMetadata && 'setConnectionParams' in component && typeof (component as any).setConnectionParams === 'function') {
          console.log(`[Host]   Calling setConnectionParams for ${componentType}`);
          try {
            await (component as any).setConnectionParams(config);
          } catch (err) {
            console.error(`[Host] Error in setConnectionParams for ${componentType}:`, err);
          }
        }
      }

      // Add component with restoration flag
      space.addComponent(component, componentId, true);

      console.log(`[Host]   Restored component: ${componentType} (${componentId})`);
    }
  }

  /**
   * Load an AXON component from a module URL and register it
   */
  private async loadAxonComponent(componentType: string, axonMetadata: any): Promise<void> {
    const { moduleUrl } = axonMetadata;

    // Fetch module code
    const response = await fetch(moduleUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const moduleCode = await response.text();

    // Create module environment
    const { createAxonEnvironment } = await import('../axon/environment');
    const env = createAxonEnvironment();

    // Write module to temp file for proper Node.js module loading
    const Module = require('module');
    const { join, dirname } = await import('path');
    const { writeFileSync, unlinkSync } = await import('fs');
    const { tmpdir } = await import('os');

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
    const moduleExports = axonModule.exports;

    // Clean up temp file after a delay
    setTimeout(() => {
      try {
        delete require.cache[tempFile];
        unlinkSync(tempFile);
      } catch (e) {}
    }, 1000);

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

        // Register all components from the module
        for (const [name, cls] of Object.entries(moduleExportsObject.components)) {
          if (typeof cls === 'function') {
            const className = (cls as any).name || name;
            if (!ComponentRegistry.has(className)) {
              ComponentRegistry.register(className, cls as any);
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
      console.log(`[Host] Registered AXON component: ${componentType}`);
    } else {
      throw new Error(`Module did not export component '${componentType}' in components object`);
    }
  }
}
