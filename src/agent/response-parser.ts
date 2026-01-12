/**
 * AgentResponseParser - Parses raw LLM output into VEIL facets
 *
 * Extracted from BasicAgent to enable parsing in ActivationCompletedHandler.
 * This allows the raw LLM output to be carried through activation:completed events,
 * making the actual agent response visible for debugging and future streaming support.
 */

import { Facet, OutgoingVEILOperation } from '../veil/types';
import { ParsedCompletion, ToolDefinition } from './types';
import { parseInlineParameters } from './action-parser';
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

  // Protect backticked content from being parsed as actions
  const backtickPlaceholders: string[] = [];
  let protectedContent = turnContent.replace(/`([^`]+)`/g, (match, content) => {
    const placeholder = `__BACKTICK_${backtickPlaceholders.length}__`;
    backtickPlaceholders.push(match);
    return placeholder;
  });

  // Parse {@element.action} syntax - track position
  const actionRegex = /\{@([\w.:-]+)(?:\s*\(([^)]*)\)|\s*\{([\s\S]*?)\})?\}/g;
  let actionMatch;
  while ((actionMatch = actionRegex.exec(protectedContent)) !== null) {
    const fullPath = actionMatch[1];
    const inlineParams = actionMatch[2];
    const blockParams = actionMatch[3];
    const position = actionMatch.index;
    const matchEnd = position + actionMatch[0].length;

    parsedRanges.push({ start: position, end: matchEnd });

    const pathParts = fullPath.split('.');
    let parameters: Record<string, any> = {};

    if (inlineParams) {
      parameters = parseInlineParameters(inlineParams);
    } else if (blockParams) {
      parameters = parseBlockParameters(blockParams);
    }

    // Restore backticks in parameters
    restoreBackticksInParams(parameters, backtickPlaceholders);

    // Extract alias from parameters (alias is metadata, not a tool parameter)
    const alias = parameters.alias as string | undefined;
    if (alias) delete parameters.alias;

    const toolName = pathParts.join('.');
    const element: PositionedElement = {
      position,
      operation: {
        type: 'addFacet',
        facet: createActionFacet(toolName, parameters, agentId, agentName, defaultStreamId, alias)
      }
    };

    // Emit event if tool is registered
    const tool = tools?.get(toolName);
    if (tool?.emitEvent) {
      element.event = {
        topic: tool.emitEvent.topic,
        payload: {
          path: pathParts,
          action: pathParts[pathParts.length - 1],
          parameters: Object.keys(parameters).length > 0 ? parameters : {},
          ...(tool.emitEvent.payloadTemplate || {})
        }
      };
    }

    elements.push(element);
  }

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

  // Parse legacy tool calls - track position
  const toolRegex = /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  let toolMatch;
  while ((toolMatch = toolRegex.exec(turnContent)) !== null) {
    const position = toolMatch.index;
    parsedRanges.push({ start: position, end: position + toolMatch[0].length });

    const toolName = toolMatch[1];
    const paramContent = toolMatch[2];

    const params: Record<string, any> = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramContent)) !== null) {
      params[paramMatch[1]] = parseParameterValue(paramMatch[2]);
    }

    elements.push({
      position,
      operation: {
        type: 'addFacet',
        facet: createActionFacet(toolName, params, agentId, agentName, defaultStreamId)
      }
    });
  }

  // Parse <action> tags (new format with multiline content) - track position
  const actionTagRegex = /<action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/action>/g;
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

function parseBlockParameters(blockParams: string): Record<string, any> {
  const parameters: Record<string, any> = {};
  const lines = blockParams.trim().split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  for (const line of lines) {
    const keyMatch = line.match(/^\s*(\w+):\s*(.*)/);
    if (keyMatch) {
      if (currentKey) {
        parameters[currentKey] = currentValue.join('\n').trim();
      }
      currentKey = keyMatch[1];
      currentValue = [keyMatch[2]];
    } else if (currentKey && line.trim()) {
      currentValue.push(line);
    }
  }
  if (currentKey) {
    parameters[currentKey] = currentValue.join('\n').trim();
  }

  return parameters;
}

function restoreBackticksInParams(
  parameters: Record<string, any>,
  placeholders: string[]
): void {
  for (const key in parameters) {
    if (typeof parameters[key] === 'string') {
      let value = parameters[key];
      placeholders.forEach((original, index) => {
        value = value.replace(`__BACKTICK_${index}__`, original.slice(1, -1));
      });
      parameters[key] = value;
    }
  }
}

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
