/**
 * Lua Sandbox using Fengari
 *
 * Provides a sandboxed Lua execution environment for Connectome scripts.
 * Dangerous libraries (os, io, debug, package) are not loaded.
 */

/// <reference path="./fengari.d.ts" />

import * as fengari from 'fengari';
import * as interop from 'fengari-interop';

const {
  lua,
  lauxlib,
  lualib,
  to_luastring,
  to_jsstring,
} = fengari;

// Lua thread status codes
const LUA_OK = lua.LUA_OK;
const LUA_YIELD = lua.LUA_YIELD;
const LUA_ERRRUN = lua.LUA_ERRRUN;
const LUA_ERRSYNTAX = lua.LUA_ERRSYNTAX;
const LUA_ERRMEM = lua.LUA_ERRMEM;
const LUA_ERRERR = lua.LUA_ERRERR;

/**
 * Result of running or resuming a Lua script
 */
export interface LuaExecutionResult {
  /** Whether the script completed (vs yielded) */
  completed: boolean;

  /** Whether execution was successful */
  success: boolean;

  /** Return value(s) if completed successfully */
  returnValue?: unknown;

  /** Error message if failed */
  error?: string;

  /** If yielded, the data passed to yield */
  yieldValue?: unknown;
}

/**
 * Built-in Lua globals that should not be serialized
 */
const LUA_BUILTINS = new Set([
  // Base library
  '_G', '_VERSION', 'assert', 'collectgarbage', 'error', 'getmetatable',
  'ipairs', 'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget',
  'rawlen', 'rawset', 'select', 'setmetatable', 'tonumber', 'tostring',
  'type', 'xpcall',
  // Standard libraries
  'table', 'string', 'math', 'utf8', 'coroutine',
  // JS interop
  'js',
  // Our builtins
  'json', 'log',
]);

/**
 * Sandboxed Lua execution environment
 */
export class LuaSandbox {
  private L: any; // Lua state
  private coroutine: any; // Coroutine thread
  private toolFunctions: Map<string, (...args: unknown[]) => unknown> = new Map();
  private registeredTools: Set<string> = new Set();

  constructor() {
    this.L = lauxlib.luaL_newstate();
    this.openSafeLibraries();
    this.removeDangerousFunctions();
    this.setupInterop();
  }

  /**
   * Open only safe Lua libraries
   */
  private openSafeLibraries(): void {
    const L = this.L;

    // Base library (with restrictions applied later)
    lauxlib.luaL_requiref(L, to_luastring('_G'), lualib.luaopen_base, 1);
    lua.lua_pop(L, 1);

    // Safe libraries
    lauxlib.luaL_requiref(L, to_luastring('table'), lualib.luaopen_table, 1);
    lua.lua_pop(L, 1);

    lauxlib.luaL_requiref(L, to_luastring('string'), lualib.luaopen_string, 1);
    lua.lua_pop(L, 1);

    lauxlib.luaL_requiref(L, to_luastring('math'), lualib.luaopen_math, 1);
    lua.lua_pop(L, 1);

    lauxlib.luaL_requiref(L, to_luastring('utf8'), lualib.luaopen_utf8, 1);
    lua.lua_pop(L, 1);

    // Coroutine library (we need this for yield/resume)
    lauxlib.luaL_requiref(L, to_luastring('coroutine'), lualib.luaopen_coroutine, 1);
    lua.lua_pop(L, 1);

    // NOT loaded (dangerous):
    // - os: filesystem access, env, execute
    // - io: file I/O
    // - debug: introspection, can escape sandbox
    // - package: require, loadlib, can load arbitrary code
  }

  /**
   * Remove dangerous functions from base library
   */
  private removeDangerousFunctions(): void {
    const L = this.L;
    const dangerous = ['dofile', 'loadfile', 'load', 'loadstring'];

    for (const fn of dangerous) {
      lua.lua_pushnil(L);
      lua.lua_setglobal(L, to_luastring(fn));
    }
  }

  /**
   * Setup JS interop for value conversion
   */
  private setupInterop(): void {
    // Push interop module for later use
    interop.luaopen_js(this.L);
    lua.lua_setglobal(this.L, to_luastring('js'));
  }

  /**
   * Register a tool function that can be called from Lua.
   * When called, the function will yield with the tool call info.
   *
   * @param name Tool name (becomes Lua function name)
   * @param handler Optional handler for synchronous execution (not used for VEIL-based async)
   */
  registerTool(name: string, handler?: (...args: unknown[]) => unknown): void {
    if (handler) {
      this.toolFunctions.set(name, handler);
    }

    // Track registered tool for serialization exclusion
    this.registeredTools.add(name);

    const L = this.L;

    // Create a Lua function that yields with tool call info
    // The yield value is a table: { __tool_call = true, name = "...", args = {...} }
    const luaCode = `
      function ${name}(...)
        return coroutine.yield({
          __tool_call = true,
          name = "${name}",
          args = {...}
        })
      end
    `;

    const status = lauxlib.luaL_dostring(L, to_luastring(luaCode));
    if (status !== LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      throw new Error(`Failed to register tool ${name}: ${err}`);
    }
  }

  /**
   * Load a Lua script into a coroutine for execution
   */
  loadScript(code: string): void {
    const L = this.L;

    // Create a new coroutine
    this.coroutine = lua.lua_newthread(L);

    // Load the script into the coroutine
    const status = lauxlib.luaL_loadstring(this.coroutine, to_luastring(code));
    if (status !== LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(this.coroutine, -1));
      lua.lua_pop(this.coroutine, 1);
      throw new Error(`Lua syntax error: ${err}`);
    }
  }

  /**
   * Start or resume script execution
   * @param resumeValue Value to pass back from yield (for tool call results)
   */
  run(resumeValue?: unknown): LuaExecutionResult {
    try {
      if (!this.coroutine) {
        return {
          completed: true,
          success: false,
          error: 'No script loaded',
        };
      }

      const co = this.coroutine;
      let nargs = 0;

      // If resuming with a value, push it onto the stack
      if (resumeValue !== undefined) {
        this.pushValue(co, resumeValue);
        nargs = 1;
      }

      // Resume the coroutine
      const status = lua.lua_resume(co, this.L, nargs);

      if (status === LUA_OK) {
        // Script completed successfully
        // Check if there's a return value on the stack
        const top = lua.lua_gettop(co);
        let returnValue: unknown;
        if (top > 0) {
          returnValue = this.getValue(co, -1);
          lua.lua_pop(co, 1);
        }

        return {
          completed: true,
          success: true,
          returnValue,
        };
      } else if (status === LUA_YIELD) {
        // Script yielded (waiting for tool call)
        const yieldValue = this.getValue(co, -1);
        lua.lua_pop(co, 1);

        return {
          completed: false,
          success: true,
          yieldValue,
        };
      } else {
        // Error occurred
        const err = to_jsstring(lua.lua_tostring(co, -1));
        lua.lua_pop(co, 1);

        return {
          completed: true,
          success: false,
          error: this.formatError(status, err),
        };
      }
    } catch (e: any) {
      // Catch any JS exceptions that bubble up from fengari or fengari-interop
      return {
        completed: true,
        success: false,
        error: `JavaScript exception during Lua execution: ${e.message || String(e)}`,
      };
    }
  }

  /**
   * Check if the yield value represents a tool call
   */
  isToolCall(yieldValue: unknown): yieldValue is { __tool_call: true; name: string; args: unknown[] } {
    return (
      typeof yieldValue === 'object' &&
      yieldValue !== null &&
      (yieldValue as any).__tool_call === true &&
      typeof (yieldValue as any).name === 'string'
    );
  }

  /**
   * Push a JavaScript value onto the Lua stack
   */
  private pushValue(L: any, value: unknown): void {
    if (value === null || value === undefined) {
      lua.lua_pushnil(L);
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(L, value ? 1 : 0);
    } else if (typeof value === 'number') {
      lua.lua_pushnumber(L, value);
    } else if (typeof value === 'string') {
      lua.lua_pushstring(L, to_luastring(value));
    } else if (Array.isArray(value)) {
      // Convert array to Lua table with numeric indices
      lua.lua_newtable(L);
      for (let i = 0; i < value.length; i++) {
        this.pushValue(L, value[i]);
        lua.lua_rawseti(L, -2, i + 1); // Lua arrays are 1-indexed
      }
    } else if (typeof value === 'object') {
      // Convert object to Lua table
      lua.lua_newtable(L);
      for (const [k, v] of Object.entries(value)) {
        lua.lua_pushstring(L, to_luastring(k));
        this.pushValue(L, v);
        lua.lua_settable(L, -3);
      }
    } else {
      // Fallback: convert to string
      lua.lua_pushstring(L, to_luastring(String(value)));
    }
  }

  /**
   * Get a value from the Lua stack and convert to JavaScript
   */
  private getValue(L: any, index: number): unknown {
    const type = lua.lua_type(L, index);

    switch (type) {
      case lua.LUA_TNIL:
        return null;

      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, index) !== 0;

      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, index);

      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tostring(L, index));

      case lua.LUA_TTABLE:
        return this.tableToJS(L, index);

      case lua.LUA_TFUNCTION:
        return '[function]';

      case lua.LUA_TUSERDATA:
      case lua.LUA_TLIGHTUSERDATA:
        return '[userdata]';

      case lua.LUA_TTHREAD:
        return '[thread]';

      default:
        return null;
    }
  }

  /**
   * Convert a Lua table to a JavaScript object or array
   */
  private tableToJS(L: any, index: number): unknown {
    // Normalize index to absolute position
    if (index < 0) {
      index = lua.lua_gettop(L) + index + 1;
    }

    // Check if it's an array (sequential integer keys starting from 1)
    const len = lua.lua_rawlen(L, index);
    let isArray = true;

    // Quick check: if table has length > 0, verify first key
    if (len > 0) {
      lua.lua_rawgeti(L, index, 1);
      isArray = lua.lua_type(L, -1) !== lua.LUA_TNIL;
      lua.lua_pop(L, 1);
    }

    if (isArray && len > 0) {
      // Convert as array
      const arr: unknown[] = [];
      for (let i = 1; i <= len; i++) {
        lua.lua_rawgeti(L, index, i);
        arr.push(this.getValue(L, -1));
        lua.lua_pop(L, 1);
      }
      return arr;
    }

    // Check if table is empty (for varargs {}, return empty array)
    if (len === 0) {
      lua.lua_pushnil(L);
      if (lua.lua_next(L, index) === 0) {
        // Table has no keys at all - return empty array
        // This handles the common case of {...} with no varargs
        return [];
      }
      // Table has keys but no array length - continue to object conversion
      lua.lua_pop(L, 2); // Pop key and value
    }

    // Convert as object
    const obj: Record<string, unknown> = {};
    lua.lua_pushnil(L); // First key

    while (lua.lua_next(L, index) !== 0) {
      // Key is at -2, value at -1
      const keyType = lua.lua_type(L, -2);
      let key: string;

      if (keyType === lua.LUA_TSTRING) {
        key = to_jsstring(lua.lua_tostring(L, -2));
      } else if (keyType === lua.LUA_TNUMBER) {
        key = String(lua.lua_tonumber(L, -2));
      } else {
        // Skip non-string/number keys
        lua.lua_pop(L, 1);
        continue;
      }

      obj[key] = this.getValue(L, -1);
      lua.lua_pop(L, 1); // Pop value, keep key for next iteration
    }

    return obj;
  }

  /**
   * Format a Lua error with status code
   */
  private formatError(status: number, message: string): string {
    const statusNames: Record<number, string> = {
      [LUA_ERRRUN]: 'runtime error',
      [LUA_ERRSYNTAX]: 'syntax error',
      [LUA_ERRMEM]: 'memory allocation error',
      [LUA_ERRERR]: 'error handler error',
    };

    const statusName = statusNames[status] || `error ${status}`;
    return `Lua ${statusName}: ${message}`;
  }

  // ============================================
  // SERIALIZATION METHODS (for session persistence)
  // ============================================

  /**
   * Serialize all user-defined globals to a JSON-compatible object.
   * Excludes built-in functions, libraries, and registered tools.
   * Functions, threads, and userdata are skipped (not serializable).
   *
   * @returns Object with serializable globals
   */
  serializeGlobals(): Record<string, unknown> {
    const L = this.L;
    if (!L) return {};

    const result: Record<string, unknown> = {};

    // Get _G table
    lua.lua_getglobal(L, to_luastring('_G'));
    const gIndex = lua.lua_gettop(L);

    // Iterate through _G
    lua.lua_pushnil(L);
    while (lua.lua_next(L, gIndex) !== 0) {
      // Key at -2, value at -1
      const keyType = lua.lua_type(L, -2);

      if (keyType === lua.LUA_TSTRING) {
        const key = to_jsstring(lua.lua_tostring(L, -2));

        // Skip built-ins and registered tools
        if (!this.shouldSerializeGlobal(key)) {
          lua.lua_pop(L, 1);
          continue;
        }

        // Serialize the value (starting at depth 0)
        const value = this.serializeValue(L, -1, 0, key);
        if (value !== undefined) {
          result[key] = value;
        }
      }

      lua.lua_pop(L, 1); // Pop value, keep key
    }

    lua.lua_pop(L, 1); // Pop _G

    return result;
  }

  /**
   * Check if a global should be serialized
   */
  private shouldSerializeGlobal(name: string): boolean {
    // Skip Lua built-ins
    if (LUA_BUILTINS.has(name)) return false;

    // Skip registered tools (they're functions that yield)
    if (this.registeredTools.has(name)) return false;

    return true;
  }

  /** Maximum depth for table serialization to prevent infinite recursion */
  private static readonly MAX_SERIALIZE_DEPTH = 50;

  /**
   * Serialize a Lua value to JSON-compatible format.
   * Returns undefined for non-serializable values (functions, threads, userdata).
   */
  private serializeValue(
    L: any,
    index: number,
    depth: number,
    path: string
  ): unknown {
    // Prevent infinite recursion
    if (depth > LuaSandbox.MAX_SERIALIZE_DEPTH) {
      return { __truncated: true, originalType: 'table', reason: 'max depth exceeded' };
    }

    const type = lua.lua_type(L, index);

    switch (type) {
      case lua.LUA_TNIL:
        return null;

      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, index) !== 0;

      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, index);

      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tostring(L, index));

      case lua.LUA_TTABLE:
        return this.serializeTable(L, index, depth, path);

      case lua.LUA_TFUNCTION:
      case lua.LUA_TUSERDATA:
      case lua.LUA_TLIGHTUSERDATA:
      case lua.LUA_TTHREAD:
        // Non-serializable types - skip silently
        return undefined;

      default:
        return undefined;
    }
  }

  /**
   * Serialize a Lua table to JSON-compatible format.
   * Uses depth limiting to prevent infinite recursion from circular references.
   */
  private serializeTable(
    L: any,
    index: number,
    depth: number,
    path: string
  ): unknown {
    // Normalize index
    if (index < 0) {
      index = lua.lua_gettop(L) + index + 1;
    }

    // Check if it's an array
    const len = lua.lua_rawlen(L, index);
    let isArray = len > 0;

    if (isArray) {
      lua.lua_rawgeti(L, index, 1);
      isArray = lua.lua_type(L, -1) !== lua.LUA_TNIL;
      lua.lua_pop(L, 1);
    }

    if (isArray) {
      // Serialize as array
      const arr: unknown[] = [];
      for (let i = 1; i <= len; i++) {
        lua.lua_rawgeti(L, index, i);
        const value = this.serializeValue(L, -1, depth + 1, `${path}[${i}]`);
        arr.push(value !== undefined ? value : null);
        lua.lua_pop(L, 1);
      }
      return arr;
    }

    // Check if table is completely empty
    if (len === 0) {
      lua.lua_pushnil(L);
      if (lua.lua_next(L, index) === 0) {
        return [];
      }
      lua.lua_pop(L, 2);
    }

    // Serialize as object
    const obj: Record<string, unknown> = {};
    lua.lua_pushnil(L);

    while (lua.lua_next(L, index) !== 0) {
      const keyType = lua.lua_type(L, -2);
      let key: string;

      if (keyType === lua.LUA_TSTRING) {
        key = to_jsstring(lua.lua_tostring(L, -2));
      } else if (keyType === lua.LUA_TNUMBER) {
        key = String(lua.lua_tonumber(L, -2));
      } else {
        lua.lua_pop(L, 1);
        continue;
      }

      const value = this.serializeValue(L, -1, depth + 1, `${path}.${key}`);
      if (value !== undefined) {
        obj[key] = value;
      }

      lua.lua_pop(L, 1);
    }

    return obj;
  }

  /**
   * Inject serialized globals back into the Lua environment.
   * Used when restoring a session from persistence.
   *
   * @param data Serialized globals from serializeGlobals()
   */
  injectGlobals(data: Record<string, unknown>): void {
    const L = this.L;
    if (!L) return;

    for (const [key, value] of Object.entries(data)) {
      // Skip special markers
      if (typeof value === 'object' && value !== null) {
        if ((value as any).__circular_ref || (value as any).__truncated) {
          continue;
        }
      }

      this.pushValue(L, value);
      lua.lua_setglobal(L, to_luastring(key));
    }
  }

  /**
   * Get list of user-defined global names (for session:inspect)
   */
  getUserGlobals(): string[] {
    const L = this.L;
    if (!L) return [];

    const globals: string[] = [];

    lua.lua_getglobal(L, to_luastring('_G'));
    const gIndex = lua.lua_gettop(L);

    lua.lua_pushnil(L);
    while (lua.lua_next(L, gIndex) !== 0) {
      const keyType = lua.lua_type(L, -2);

      if (keyType === lua.LUA_TSTRING) {
        const key = to_jsstring(lua.lua_tostring(L, -2));
        if (this.shouldSerializeGlobal(key)) {
          globals.push(key);
        }
      }

      lua.lua_pop(L, 1);
    }

    lua.lua_pop(L, 1); // Pop _G

    return globals.sort();
  }

  /**
   * Get the set of registered tool names
   */
  getRegisteredTools(): Set<string> {
    return new Set(this.registeredTools);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.L) {
      lua.lua_close(this.L);
      this.L = null;
      this.coroutine = null;
    }
  }
}

/**
 * Create a new sandboxed Lua environment
 */
export function createLuaSandbox(): LuaSandbox {
  return new LuaSandbox();
}
