/**
 * AXON Component Interfaces
 *
 * Re-exports core interfaces from the shared @connectome/axon-interfaces package.
 * The full IAxonEnvironment is now defined in that package.
 */

// Re-export all interfaces from the shared package
export * from '@connectome/axon-interfaces';

import { IAxonManifest } from '@connectome/axon-interfaces';

/**
 * Extended manifest with component exports metadata
 */
export interface IAxonManifestExtended extends IAxonManifest {
  // Fields for component exports
  exports?: {
    components?: string[];      // Component class names
  };

  // Metadata for each export
  metadata?: {
    [exportName: string]: {
      description?: string;
      priority?: number;        // FLEX priority (0-400)
      topics?: string[];        // For event-handling components
      facetFilters?: any[];     // For facet-watching components
      requirements?: string[];  // External dependencies needed
    };
  };
}

/**
 * Module exports structure
 */
export interface IAxonModuleExports {
  // All components exported by the module
  components?: Record<string, any>;

  // Optional initializer for connection params
  initializer?: {
    setConnectionParams?: (params: any) => void | Promise<void>;
    initialize?: (params: any) => void | Promise<void>;
  };
}
