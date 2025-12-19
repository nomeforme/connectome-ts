import type { Frame, StreamRef } from '../veil/types';
import type { SpaceEvent } from '../spaces/types';
import type { RenderedContext } from '../hud/types-v2';
import type { ComponentConstraintFacet } from '../spaces/constraints';

export interface DebugComponentSnapshot {
  id: string;
  name: string;
  constraints: ComponentConstraintFacet[];
  enabled: boolean;
  state?: Record<string, any>;
}

export interface ComponentExecutionRecord {
  componentId: string;
  componentName: string;
  durationMs: number;
  deltaStartIndex: number;
  deltaEndIndex: number;
  emittedEvents: number;
  error?: string;

  // Detailed execution context (optional, for detailed inspection)
  context?: {
    inputEvent?: {
      topic: string;
      source?: any;
      payload?: any;
    };
    stateSnapshot?: {
      facetCount: number;
      sequence: number;
    };
    eventBufferSnapshot?: Array<{
      topic: string;
      source?: any;
      target?: any;
      payload?: any;
    }>;
  };

  // Events emitted by this component (optional)
  emittedEventDetails?: Array<{
    topic: string;
    source?: any;
    target?: any;
    payload?: any;
  }>;
}

export interface DebugFrameStartContext {
  queuedEvents: number;
  components?: DebugComponentSnapshot[];
}

export interface DebugFrameCompleteContext {
  durationMs: number;
  processedEvents: number;
  componentExecutions?: ComponentExecutionRecord[];
}

export interface DebugAgentFrameContext {
  agentId?: string;
  agentName?: string;
}

export interface DebugEventContext {
  targetId?: string;
}

/**
 * Observer interface used by the Space to notify the debug server about runtime activity.
 */
export interface DebugObserver {
  onFrameStart?(frame: Frame, context: DebugFrameStartContext): void;
  onFrameEvent?(frame: Frame, event: SpaceEvent, context: DebugEventContext): void;
  onFrameComplete?(frame: Frame, context: DebugFrameCompleteContext): void;
  onAgentFrame?(frame: Frame, context: DebugAgentFrameContext): void;
}
