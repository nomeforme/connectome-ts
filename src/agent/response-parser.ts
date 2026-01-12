/**
 * AgentResponseParser - Parses raw LLM output into VEIL facets
 *
 * Extracted from BasicAgent to enable parsing in ActivationCompletedHandler.
 * This allows the raw LLM output to be carried through activation:completed events,
 * making the actual agent response visible for debugging and future streaming support.
 */

import { Facet, OutgoingVEILOperation } from '../veil/types';
import { ParsedCompletion, ToolDefinition } from './types';
import { stripTurnMarkers } from '../utils/turn-markers';

export interface ParserConfig {
  /** Agent ID for facet attribution */
  agentId: string;
  /** Agent name for facet attribution */
  agentName?: string;
  /** Default stream ID for facets */
  defaultStreamId?: string;
  /** Registered tools (for event emission) */
  tools?: Map<string, ToolDefinition>;
}

export interface ParsedResponse {
  /** Parsed VEIL operations (facets to add) */
  operations: OutgoingVEILOperation[];
  /** Events to emit (for tool invocations) */
  events: Array<{ topic: string; payload: any }>;
  /** Whether the agent has more to say (hit token limit) */
  hasMoreToSay: boolean;
}

/**
 * Parse raw LLM completion into VEIL operations and events
 */
/**
 * Parsed element with position for chronological ordering
 */
interface PositionedElement {
  position: number;
  operation: OutgoingVEILOperation;
  event?: { topic: string; payload: any };
}

export function parseAgentResponse(
  rawOutput: string,
  config: ParserConfig
): ParsedResponse {
  const events: Array<{ topic: string; payload: any }> = [];
  let hasMoreToSay = false;

  const { agentId, agentName, defaultStreamId = 'default', tools } = config;

  // Normalize turn markers
  let turnContent = stripTurnMarkers(rawOutput);

  // Collect all parsed elements with their positions for chronological ordering
  const elements: PositionedElement[] = [];

  // Track positions of all parsed elements for speech segmentation
  const parsedRanges: Array<{ start: number; end: number }> = [];

  // Parse thoughts - track position
  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
  let thoughtMatch;
  while ((thoughtMatch = thoughtRegex.exec(turnContent)) !== null) {
    const position = thoughtMatch.index;
    parsedRanges.push({ start: position, end: position + thoughtMatch[0].length });

    elements.push({
      position,
      operation: {
        type: 'addFacet',
        facet: createThoughtFacet(thoughtMatch[1].trim(), agentId, agentName, defaultStreamId)
      }
    });
  }

  // Parse <cnctm:action> tags - the primary tool call format
  const actionTagRegex = /<cnctm:action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/cnctm:action>/g;
  let actionTagMatch;
  while ((actionTagMatch = actionTagRegex.exec(turnContent)) !== null) {
    const position = actionTagMatch.index;
    parsedRanges.push({ start: position, end: position + actionTagMatch[0].length });

    const actionName = actionTagMatch[1];
    const attributesStr = actionTagMatch[2];
    let content = actionTagMatch[3];

    // Parse attributes
    const attributes: Record<string, any> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
      const key = attrMatch[1];
      let value: any = attrMatch[2];
      if (/^\d+$/.test(value)) {
        value = parseInt(value, 10);
      } else if (/^\d+\.\d+$/.test(value)) {
        value = parseFloat(value);
      }
      attributes[key] = value;
    }

    // Handle CDATA
    const cdataMatch = content.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdataMatch) {
      content = cdataMatch[1];
    } else {
      content = content.replace(/^\n/, '').replace(/\n\s*$/, '');
    }

    // Extract alias before merging into params (alias is metadata, not a tool parameter)
    const alias = attributes.alias as string | undefined;
    const { alias: _, ...otherAttributes } = attributes;
    const params: Record<string, any> = { ...otherAttributes, content };

    const element: PositionedElement = {
      position,
      operation: {
        type: 'addFacet',
        facet: createActionFacet(actionName, params, agentId, agentName, defaultStreamId, alias)
      }
    };

    // Emit event if tool is registered
    const tool = tools?.get(actionName);
    if (tool?.emitEvent) {
      element.event = {
        topic: tool.emitEvent.topic,
        payload: {
          action: actionName,
          parameters: params,
          ...(tool.emitEvent.payloadTemplate || {})
        }
      };
    }

    elements.push(element);
  }

  // Parse <cnctm:function_calls> with <cnctm:invoke> tags (Anthropic-style format)
  const cnctmFunctionCallsRegex = /<cnctm:function_calls>([\s\S]*?)<\/cnctm:function_calls>/g;
  let fnCallsMatch;
  while ((fnCallsMatch = cnctmFunctionCallsRegex.exec(turnContent)) !== null) {
    const blockPosition = fnCallsMatch.index;
    const blockEnd = blockPosition + fnCallsMatch[0].length;
    parsedRanges.push({ start: blockPosition, end: blockEnd });

    const invokeContent = fnCallsMatch[1];
    
    // Parse individual <cnctm:invoke> tags within the block
    const invokeRegex = /<cnctm:invoke\s+name="([^"]+)">([\s\S]*?)<\/cnctm:invoke>/g;
    let invokeMatch;
    let invokeIndex = 0;
    while ((invokeMatch = invokeRegex.exec(invokeContent)) !== null) {
      const toolName = invokeMatch[1];
      const paramContent = invokeMatch[2];

      // Parse <cnctm:parameter> tags
      const params: Record<string, any> = {};
      const paramRegex = /<cnctm:parameter\s+name="([^"]+)">([\s\S]*?)<\/cnctm:parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(paramContent)) !== null) {
        params[paramMatch[1]] = parseParameterValue(paramMatch[2].trim());
      }

      const element: PositionedElement = {
        position: blockPosition + invokeIndex,  // Maintain order within block
        operation: {
          type: 'addFacet',
          facet: createActionFacet(toolName, params, agentId, agentName, defaultStreamId)
        }
      };

      // Emit event if tool is registered
      const tool = tools?.get(toolName);
      if (tool?.emitEvent) {
        element.event = {
          topic: tool.emitEvent.topic,
          payload: {
            action: toolName,
            parameters: params,
            ...(tool.emitEvent.payloadTemplate || {})
          }
        };
      }

      elements.push(element);
      invokeIndex++;
    }
  }

  // Extract speech segments between parsed elements
  // Sort ranges by start position
  parsedRanges.sort((a, b) => a.start - b.start);

  // Find gaps between parsed ranges - these are speech segments
  let lastEnd = 0;
  for (const range of parsedRanges) {
    if (range.start > lastEnd) {
      // There's a gap - extract speech content
      let segment = turnContent.substring(lastEnd, range.start);
      segment = stripTurnMarkers(segment).trim();
      if (segment) {
        elements.push({
          position: lastEnd,
          operation: {
            type: 'addFacet',
            facet: createSpeechFacet(segment, agentId, agentName, defaultStreamId)
          }
        });
      }
    }
    lastEnd = Math.max(lastEnd, range.end);
  }

  // Check for trailing speech after last parsed element
  if (lastEnd < turnContent.length) {
    let segment = turnContent.substring(lastEnd);
    segment = stripTurnMarkers(segment).trim();
    if (segment) {
      elements.push({
        position: lastEnd,
        operation: {
          type: 'addFacet',
          facet: createSpeechFacet(segment, agentId, agentName, defaultStreamId)
        }
      });
    }
  }

  // Sort all elements by their position in the text (chronological order)
  elements.sort((a, b) => a.position - b.position);

  // Extract operations and events from sorted elements
  const operations: OutgoingVEILOperation[] = [];
  for (const element of elements) {
    operations.push(element.operation);
    if (element.event) {
      events.push(element.event);
    }
  }

  return { operations, events, hasMoreToSay };
}

// Helper functions

function parseParameterValue(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function generateFacetId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function createActionFacet(
  toolName: string,
  parameters: Record<string, any>,
  agentId: string,
  agentName: string | undefined,
  streamId: string,
  alias?: string
): Facet {
  return {
    id: generateFacetId('agent-action'),
    type: 'action',
    content: JSON.stringify(parameters),
    state: { toolName, parameters, ...(alias ? { alias } : {}) },
    agentId,
    agentName,
    streamId
  };
}

function createSpeechFacet(
  content: string,
  agentId: string,
  agentName: string | undefined,
  streamId: string
): Facet {
  return {
    id: generateFacetId('agent-speech'),
    type: 'speech',
    content,
    agentId,
    agentName,
    streamId
  };
}

function createThoughtFacet(
  content: string,
  agentId: string,
  agentName: string | undefined,
  streamId: string
): Facet {
  return {
    id: generateFacetId('agent-thought'),
    type: 'thought',
    content,
    agentId,
    agentName,
    streamId
  };
}
