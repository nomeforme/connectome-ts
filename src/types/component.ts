/**
 * Base Component interface for MARTEM architecture
 * All processing components (Modulator, Afferent, Receptor, Transform, Effector, Maintainer)
 * extend this base interface
 */

import { Space } from '../spaces/space';

/**
 * Minimal component interface - just lifecycle management
 */
export interface Component {
  /**
   * Called when the component is attached to the space
   */
  onMount?(): void | Promise<void>;
  
  /**
   * Called when the component is removed from the space
   */
  onUnmount?(): void | Promise<void>;
  
  /**
   * Optional destroy method for cleanup beyond unmount
   * Called when the component needs complete cleanup (e.g., closing connections)
   */
  destroy?(): Promise<void>;
}

/**
 * Component metadata for registration and management
 */
export interface ComponentMetadata {
  /** Unique component type identifier (e.g., 'discord-afferent', 'rate-limit-modulator') */
  componentType: string;

  /** Component priority for FLEX ordering */
  priority?: number;

  /** Optional version for hot-reload compatibility */
  version?: string;

  /** Optional dependencies on other components */
  dependencies?: string[];
}

/**
 * Component constructor type
 */
export type ComponentConstructor<T extends Component = Component> = new (...args: any[]) => T;

/**
 * Component registry entry
 */
export interface ComponentRegistryEntry {
  constructor: ComponentConstructor;
  metadata: ComponentMetadata;
}
