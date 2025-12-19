/**
 * Tool Registry for Lua Scripting
 *
 * Provides a centralized registry of tools that can be called from Lua scripts.
 * Tools are registered with their metadata (name, description, parameters) and
 * can be bound to Lua sandboxes for script execution.
 */

import { IToolRegistry, ScriptableTool, ToolParameter } from './types';
import { LuaSandbox } from './lua-sandbox';
import type { ToolDefinition } from '../agent/types';

/**
 * Default implementation of IToolRegistry.
 *
 * This registry manages scriptable tools and can generate Lua bindings
 * for them when a script executes.
 */
export class ToolRegistry implements IToolRegistry {
  private tools: Map<string, ScriptableTool> = new Map();

  /**
   * Register a new tool.
   * If a tool with the same name exists, it will be replaced.
   */
  register(tool: ScriptableTool): void {
    // Validate tool name (must be valid Lua identifier)
    if (!isValidLuaIdentifier(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}": must be a valid Lua identifier ` +
          `(start with letter/underscore, contain only letters/digits/underscores)`
      );
    }

    // Validate against reserved Lua keywords
    if (isLuaKeyword(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": cannot use Lua reserved keyword`);
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get all registered tools.
   */
  getTools(): ScriptableTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by name.
   */
  getTool(name: string): ScriptableTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Bind all registered tools to a Lua sandbox.
   *
   * This creates Lua functions for each tool that yield on call,
   * allowing the coroutine-based blocking mechanism to work.
   */
  bindToSandbox(sandbox: LuaSandbox): void {
    for (const tool of this.tools.values()) {
      sandbox.registerTool(tool.name);
    }
  }

  /**
   * Generate Lua documentation comment for a tool.
   * Can be used to inject help text into scripts.
   */
  generateToolDocs(toolName: string): string | undefined {
    const tool = this.tools.get(toolName);
    if (!tool) return undefined;

    const paramDocs = tool.parameters
      .map((p) => {
        const req = p.required !== false ? '(required)' : '(optional)';
        return `-- @param ${p.name} ${p.type} ${req} - ${p.description}`;
      })
      .join('\n');

    return `-- ${tool.name}: ${tool.description}\n${paramDocs}`;
  }

  /**
   * Generate Lua documentation for all tools.
   */
  generateAllToolDocs(): string {
    const docs: string[] = ['-- Available Tools', '--'];

    for (const tool of this.tools.values()) {
      docs.push(this.generateToolDocs(tool.name)!);
      docs.push('');
    }

    return docs.join('\n');
  }
}

/**
 * Check if a string is a valid Lua identifier.
 */
function isValidLuaIdentifier(name: string): boolean {
  // Must start with letter or underscore, followed by letters, digits, or underscores
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Lua reserved keywords that cannot be used as function names.
 */
const LUA_KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
]);

/**
 * Check if a name is a Lua reserved keyword.
 */
function isLuaKeyword(name: string): boolean {
  return LUA_KEYWORDS.has(name);
}

// ============================================
// BUILDER PATTERN FOR TOOL CREATION
// ============================================

/**
 * Builder for creating ScriptableTool definitions.
 *
 * Example:
 * ```typescript
 * const tool = new ToolBuilder('getWeather')
 *   .description('Get current weather for a location')
 *   .param('location', 'string', 'City name or coordinates', true)
 *   .param('units', 'string', 'Temperature units (celsius/fahrenheit)', false, 'celsius')
 *   .handler('WeatherService')
 *   .build();
 * ```
 */
export class ToolBuilder {
  private tool: ScriptableTool;

  constructor(name: string) {
    this.tool = {
      name,
      description: '',
      parameters: [],
    };
  }

  /**
   * Set the tool description.
   */
  description(desc: string): this {
    this.tool.description = desc;
    return this;
  }

  /**
   * Add a parameter to the tool.
   */
  param(
    name: string,
    type: ToolParameter['type'],
    description: string,
    required: boolean = true,
    defaultValue?: unknown
  ): this {
    this.tool.parameters.push({
      name,
      type,
      description,
      required,
      defaultValue,
    });
    return this;
  }

  /**
   * Set the handler component type.
   */
  handler(componentType: string): this {
    this.tool.handlerComponentType = componentType;
    return this;
  }

  /**
   * Build the final tool definition.
   */
  build(): ScriptableTool {
    if (!this.tool.description) {
      throw new Error(`Tool "${this.tool.name}" must have a description`);
    }
    return { ...this.tool };
  }
}

// ============================================
// DECORATOR-BASED TOOL REGISTRATION (FUTURE)
// ============================================

/**
 * Decorator to mark a method as a scriptable tool.
 * (For future use when decorators are more widely supported)
 *
 * Example:
 * ```typescript
 * class WeatherService {
 *   @scriptableTool({
 *     description: 'Get weather for a location',
 *     parameters: [{ name: 'location', type: 'string', description: 'City' }]
 *   })
 *   async getWeather(location: string): Promise<WeatherData> { ... }
 * }
 * ```
 */
export function scriptableTool(
  options: Omit<ScriptableTool, 'name'>
): (target: any, propertyKey: string, descriptor: PropertyDescriptor) => void {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    // Store metadata for later extraction
    if (!target.__scriptableTools) {
      target.__scriptableTools = [];
    }
    target.__scriptableTools.push({
      name: propertyKey,
      ...options,
    });
  };
}

/**
 * Extract scriptable tools from a class instance.
 */
export function extractScriptableTools(instance: any): ScriptableTool[] {
  const proto = Object.getPrototypeOf(instance);
  return proto.__scriptableTools || [];
}

// ============================================
// GLOBAL REGISTRY SINGLETON
// ============================================

let globalRegistry: ToolRegistry | null = null;

/**
 * Get the global tool registry.
 * Creates one if it doesn't exist.
 */
export function getGlobalToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry();
  }
  return globalRegistry;
}

/**
 * Set a custom global tool registry.
 */
export function setGlobalToolRegistry(registry: ToolRegistry): void {
  globalRegistry = registry;
}

/**
 * Create a new tool registry.
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

// ============================================
// TOOL DEFINITION CONVERSION
// ============================================

/**
 * Convert a JSON Schema type to a ToolParameter type.
 */
function jsonSchemaTypeToToolType(schemaType: string | undefined): ToolParameter['type'] {
  switch (schemaType) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'array':
      return 'array';
    default:
      return 'any';
  }
}

/**
 * Convert a ToolDefinition (agent system) to a ScriptableTool (scripting system).
 *
 * This allows tools registered in the agent system to be made available to Lua scripts.
 *
 * @param toolDef The agent's tool definition
 * @returns A ScriptableTool that can be registered with ToolRegistry
 */
export function toolDefinitionToScriptable(toolDef: ToolDefinition): ScriptableTool {
  const parameters: ToolParameter[] = [];

  // Convert JSON schema parameters to ToolParameter array
  if (toolDef.parameters) {
    const props = toolDef.parameters.properties || toolDef.parameters;
    const required = new Set(toolDef.parameters.required || []);

    for (const [name, schema] of Object.entries(props)) {
      // Skip $schema and other meta properties
      if (name.startsWith('$') || name === 'required' || name === 'type') {
        continue;
      }

      const schemaObj = schema as { type?: string; description?: string; default?: unknown };
      parameters.push({
        name,
        type: jsonSchemaTypeToToolType(schemaObj.type),
        description: schemaObj.description || `Parameter ${name}`,
        required: required.has(name),
        defaultValue: schemaObj.default,
      });
    }
  }

  return {
    name: toolDef.name,
    description: toolDef.description,
    parameters,
    handlerComponentType: toolDef.componentId || toolDef.componentPath?.join('.'),
  };
}

/**
 * Convert multiple ToolDefinitions to ScriptableTools.
 */
export function toolDefinitionsToScriptable(toolDefs: ToolDefinition[]): ScriptableTool[] {
  return toolDefs.map(toolDefinitionToScriptable);
}

/**
 * Import tools from agent's ToolDefinition format.
 *
 * This is a convenience function for integrating with the agent system.
 *
 * @example
 * ```typescript
 * // Get tools from agent
 * const agentTools = agent.getTools();
 *
 * // Import into registry
 * importToolDefinitions(registry, agentTools);
 *
 * // Or use global registry
 * importToolDefinitions(getGlobalToolRegistry(), agentTools);
 * ```
 */
export function importToolDefinitions(registry: ToolRegistry, toolDefs: ToolDefinition[]): void {
  for (const toolDef of toolDefs) {
    try {
      const scriptable = toolDefinitionToScriptable(toolDef);
      registry.register(scriptable);
    } catch (error: any) {
      console.warn(`[ToolRegistry] Failed to import tool "${toolDef.name}": ${error.message}`);
    }
  }
}
