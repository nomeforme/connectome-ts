/**
 * Persistence system exports
 */

export * from './types';
export * from './decorators';
export * from './serialization';
// PersistenceManager removed - use PersistenceManager instead
export * from './persistence-maintainer';
export * from './file-storage';
export * from './restoration';
export * from './transition-manager';
export * from './transition-maintainer';

// Re-export commonly used items
export { persistent, persistable, noPersist, isNoPersist, Serializers } from './decorators';
export { PersistenceManager } from './persistence-maintainer';
export { ComponentRegistry } from './component-registry';
export { restoreFromSnapshot } from './restoration';
export { TransitionManager } from './transition-manager';
export { TransitionMaintainer } from './transition-maintainer';
export {
  ElementOperation as TransitionElementOperation,
  ComponentOperation as TransitionComponentOperation,
  ComponentChange as TransitionComponentChange,
  TransitionNode,
  TransitionSnapshot,
  TransitionApplicator,
  SnapshotProvider,
  FrameTransition as PersistenceFrameTransition
} from './transition-types';
