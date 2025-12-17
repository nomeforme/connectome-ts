/**
 * AgentResponseParser - Parses raw LLM output into VEIL facets
 *
 * Extracted from BasicAgent to enable parsing in ActivationCompletedReceptor.
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
export function parseAgentResponse(
  rawOutput: string,
  config: ParserConfig
): ParsedResponse {
  const operations: OutgoingVEILOperation[] = [];
  const events: Array<{ topic: string; payload: any }> = [];
  let hasMoreToSay = false;

  const { agentId, agentName, defaultStreamId = 'default', tools } = config;

  // Normalize turn markers
  let turnContent = stripTurnMarkers(rawOutput);

  // Protect backticked content from being parsed as actions
  const backtickPlaceholders: string[] = [];
  let protectedContent = turnContent.replace(/`([^`]+)`/g, (match, content) => {
    const placeholder = `__BACKTICK_${backtickPlaceholders.length}__`;
    backtickPlaceholders.push(match);
    return placeholder;
  });

  // Parse {@element.action} syntax
  const actionRegex = /\{@([\w.-]+)(?:\s*\(([^)]*)\)|\s*\{([\s\S]*?)\})?\}/g;
  let actionMatch;
  while ((actionMatch = actionRegex.exec(protectedContent)) !== null) {
    const fullPath = actionMatch[1];
    const inlineParams = actionMatch[2];
    const blockParams = actionMatch[3];

    const pathParts = fullPath.split('.');
    let parameters: Record<string, any> = {};

    if (inlineParams) {
      parameters = parseInlineParameters(inlineParams);
    } else if (blockParams) {
      parameters = parseBlockParameters(blockParams);
    }

    // Restore backticks in parameters
    restoreBackticksInParams(parameters, backtickPlaceholders);

    const toolName = pathParts.join('.');
    operations.push({
      type: 'addFacet',
      facet: createActionFacet(toolName, parameters, agentId, agentName, defaultStreamId)
    });

    // Emit event if tool is registered
    const tool = tools?.get(toolName);
    if (tool?.emitEvent) {
      events.push({
        topic: tool.emitEvent.topic,
        payload: {
          path: pathParts,
          action: pathParts[pathParts.length - 1],
          parameters: Object.keys(parameters).length > 0 ? parameters : {},
          ...(tool.emitEvent.payloadTemplate || {})
        }
      });
    }
  }

  // Parse thoughts
  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
  let thoughtMatch;
  while ((thoughtMatch = thoughtRegex.exec(turnContent)) !== null) {
    operations.push({
      type: 'addFacet',
      facet: createThoughtFacet(thoughtMatch[1].trim(), agentId, agentName, defaultStreamId)
    });
  }

  // Parse legacy tool calls
  const toolRegex = /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  let toolMatch;
  while ((toolMatch = toolRegex.exec(turnContent)) !== null) {
    const toolName = toolMatch[1];
    const paramContent = toolMatch[2];

    const params: Record<string, any> = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramContent)) !== null) {
      params[paramMatch[1]] = parseParameterValue(paramMatch[2]);
    }

    operations.push({
      type: 'addFacet',
      facet: createActionFacet(toolName, params, agentId, agentName, defaultStreamId)
    });
  }

  // Parse <action> tags (new format with multiline content)
  const actionTagRegex = /<action\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/action>/g;
  let actionTagMatch;
  while ((actionTagMatch = actionTagRegex.exec(turnContent)) !== null) {
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

    const params: Record<string, any> = { ...attributes, content };

    operations.push({
      type: 'addFacet',
      facet: createActionFacet(actionName, params, agentId, agentName, defaultStreamId)
    });

    // Emit event if tool is registered
    const tool = tools?.get(actionName);
    if (tool?.emitEvent) {
      events.push({
        topic: tool.emitEvent.topic,
        payload: {
          action: actionName,
          parameters: params,
          ...(tool.emitEvent.payloadTemplate || {})
        }
      });
    }
  }

  // Extract speech (everything not in special tags)
  let speechContent = turnContent;

  // Protect backticks
  const speechBacktickPlaceholders: string[] = [];
  let protectedSpeech = speechContent.replace(/`([^`]+)`/g, (match, content) => {
    const placeholder = `__SPEECH_BACKTICK_${speechBacktickPlaceholders.length}__`;
    speechBacktickPlaceholders.push(match);
    return placeholder;
  });

  // Remove parsed content
  protectedSpeech = protectedSpeech.replace(/<thought>[\s\S]*?<\/thought>/g, '');
  protectedSpeech = protectedSpeech.replace(/<tool_call\s+name="[^"]+"[\s\S]*?<\/tool_call>/g, '');
  protectedSpeech = protectedSpeech.replace(/<action\s+name="[^"]+"\s*[^>]*>[\s\S]*?<\/action>/g, '');
  protectedSpeech = protectedSpeech.replace(/\{@[\w.-]+(?:\s*\([^)]*\)|\s*\{[\s\S]*?\})?\}/g, '');

  // Restore backticks
  speechContent = stripTurnMarkers(protectedSpeech);
  speechBacktickPlaceholders.forEach((original, index) => {
    speechContent = speechContent.replace(`__SPEECH_BACKTICK_${index}__`, original);
  });

  speechContent = speechContent.trim();

  if (speechContent) {
    operations.push({
      type: 'addFacet',
      facet: createSpeechFacet(speechContent, agentId, agentName, defaultStreamId)
    });
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
  streamId: string
): Facet {
  return {
    id: generateFacetId('agent-action'),
    type: 'action',
    content: JSON.stringify(parameters),
    state: { toolName, parameters },
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
