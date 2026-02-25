// Register core components
import './core-components';

// VEIL exports
export * from './veil/types';
export { VEILStateManager } from './veil/veil-state';
export type { VEILStateSnapshot } from './veil/veil-state';

// Memory System exports - temporarily removed during cleanup

// Compression exports
export * from './compression/types-v2';
export { AttentionAwareCompressionEngine } from './compression/attention-aware-engine';
export { SimpleTestCompressionEngine } from './compression/simple-test-engine';

// HUD exports
export * from './hud/types-v2';
export { FrameTrackingHUD } from './hud/frame-tracking-hud';
export { ContextTransform } from './hud/context-transform';
export { 
  extractFrameRange, 
  hasFramesInRange, 
  getRenderedFrameSequences, 
  findFrameGaps 
} from './hud/frame-extraction';
export type { ExtractedFrameRange } from './hud/frame-extraction';

// LLM exports
export * from './llm/llm-interface';
export { MockLLMProvider } from './llm/mock-llm-provider';
export { AnthropicProvider } from './llm/anthropic-provider';
export { DebugLLMProvider } from './llm/debug-llm-provider';
export { debugLLMBridge } from './llm/debug-llm-bridge';
export type { DebugLLMRequest } from './llm/debug-llm-bridge';

// Space/Component exports
export type {
  ComponentRef,
  SpaceEvent,
  FrameStartEvent,
  FrameEndEvent,
  TimeEvent,
  ComponentMountEvent,
  ComponentUnmountEvent,
  AgentResponseEvent,
  ComponentLifecycle,
  EventHandler,
  TopicSubscription
} from './spaces/types';
export { Space } from './spaces/space';
export { Component as SpaceComponent } from './spaces/component';
export { ComponentManager } from './spaces/component-manager';

// Constraint types and factories
export type {
  ComponentConstraintFacet,
  PriorityConstraintFacet,
  BeforeComponentTypeConstraint,
  AfterComponentTypeConstraint,
  BeforeComponentIdConstraint,
  AfterComponentIdConstraint,
  ConstraintFacet
} from './spaces/constraints';
export {
  ComponentPriority,
  priorityConstraint,
  beforeComponentType,
  afterComponentType,
  beforeComponentId,
  afterComponentId
} from './spaces/constraints';

// Component ordering strategies
export type {
  ComponentOrderingStrategy,
  MultiConstraintOrderingOptions,
  MultiConstraintOrderingResult
} from './spaces/ordering/component-ordering';
export {
  PriorityOrderingStrategy,
  MultiConstraintOrderingStrategy
} from './spaces/ordering/component-ordering';

// Constraint graph types (for advanced usage)
export type {
  ConstraintEdge,
  ConstraintNode,
  ConstraintConflict,
  ConflictType,
  ConstraintGraphResult
} from './spaces/ordering/constraint-graph';
export { ConstraintGraphBuilder } from './spaces/ordering/constraint-graph';

// Topological sort types (for advanced usage)
export type { TopologicalSortResult } from './spaces/ordering/topological-sort';
export { TopologicalSorter } from './spaces/ordering/topological-sort';

// Ordering diagnostics
export type { OrderingSummary } from './spaces/ordering/ordering-diagnostics';
export {
  OrderingDiagnosticsFormatter,
  validateOrderingResult
} from './spaces/ordering/ordering-diagnostics';

// Component base type export
export * from './types/component';

// FLEX component types and interfaces
export * from './spaces/receptor-effector-types';

// Base Afferent for external service integration
export { BaseAfferent } from './components/base-afferent';

// VEIL Operation Receptor
export { VEILOperationReceptor } from './spaces/migration-adapters';

// Legacy RETM type guards removed - FLEX uses priority-based component ordering
// Components set their own priority property directly

// Export priority grouping utility
export { groupByPriority } from './utils/priorities';

// Note: EphemeralCleanupTransform removed - ephemeral facets naturally fade away

// Transform exports
export { StateTransitionTransform } from './transforms/state-transition-transform';
export { ContinuationTransform } from './transforms/continuation-transform';
export { CompressionTransform } from './transforms/compression-transform';
export { FrameSnapshotTransform } from './transforms/frame-snapshot-transform';

// Validation exports
export * from './validation/facet-validation';

// Agent exports
export * from './agent/types';
export { BasicAgent } from './agent/basic-agent';
export { AgentComponent, AgentEffector } from './agent/agent-component';
export { AgentElement } from './agent/agent-element';
export { createBasicAgent, type CreateAgentOptions } from './agent/agent-factory';

// Element exports
export { ConsoleChatComponent } from './elements/console-chat'; // Legacy - use console-chat-retm instead
export { 
  ConsoleAfferent, 
  ConsoleMessageReceptor, 
  ConsoleSpeechEffector,
  createConsoleElement 
} from './elements/console-chat-retm';

// Component exports
export { AxonLoaderComponent } from './components/axon-loader';
export { SpaceNotesComponent } from './components/space-notes';
export { VEILComponent, InteractiveComponent } from './components/base-components';
export { ConsoleInputReceptor, ConsoleOutputEffector } from './components/console-receptors';

// Widget exports
export * from './widgets';

// AXON exports
export { createAxonEnvironment } from './axon/environment';
export type {
  IAxonManifest,
  IAxonManifestExtended,
  IAxonModuleExports,
  IAxonComponentConstructor,
  IComponent,
  IVEILComponent,
  IInteractiveComponent,
  IAxonEnvironment
} from './axon/interfaces';

// Tracing exports
export * from './tracing';

// Persistence exports
export * from './persistence';

// Component Registry
export { ComponentRegistry } from './persistence/component-registry';

// Debug exports
export { DebugServer } from './debug';
export type { DebugServerConfig } from './debug';

// Host exports
export { ConnectomeHost, type HostConfig } from './host';
export type { ConnectomeApplication } from './host/types';
export { reference, external, type RestorableComponent } from './host/decorators';

// Scripting exports
export * from './scripting';

// gRPC exports
export { createGrpcServer, startGrpcServer, type GrpcServerOptions } from './grpc';
export * from './grpc/handlers';

// Helper/Factory exports
export {
  // ID generation
  friendlyId,
  // Event and reference factories
  createSpaceEvent,
  createComponentRef,
  createAgentActivation,
  // Facet creation factories (with validation)
  createSpeechFacet,
  createThoughtFacet,
  createActionFacet,
  createEventFacet,
  createStateFacet,
  createAmbientFacet,
  createStreamRewriteFacet,
  updateStateFacets,  // Convenience for nested state updates
  // VEIL operation factories
  addFacet,
  removeFacet,
  rewriteFacet,
  wrapFacetsAsDeltas,  // Helper for receptor migration
  changeState,  // @deprecated - alias for rewriteFacet
  updateState,  // @deprecated - alias for rewriteFacet
  changeFacet   // @deprecated - alias for rewriteFacet
} from './helpers/factories';
