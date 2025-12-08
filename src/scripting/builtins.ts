/**
 * Built-in Lua Functions for Scripting
 *
 * These functions are available to all Lua scripts without explicit registration.
 * They provide core functionality that doesn't require tool call round-trips.
 */

import { LuaSandbox } from './lua-sandbox';

// Import fengari
const fengari = require('fengari');
const { lua, lauxlib, to_luastring, to_jsstring } = fengari;
const LUA_OK = fengari.lua.LUA_OK;

/**
 * Options for installing built-ins
 */
export interface BuiltinsOptions {
  /**
   * Custom log function. If not provided, uses console.log.
   */
  logFn?: (...args: unknown[]) => void;

  /**
   * Whether to install json functions (encode/decode)
   * Default: true
   */
  enableJson?: boolean;

  /**
   * Whether to install the log function
   * Default: true
   */
  enableLog?: boolean;
}

/**
 * Install built-in functions into a Lua sandbox.
 *
 * Built-ins:
 * - `log(...)` - Debug logging (synchronous, does not enter context)
 * - `json.encode(t)` - Serialize table to JSON string
 * - `json.decode(s)` - Parse JSON string to table
 *
 * Note: `sleep` and `emit` are implemented as yielding tool-like functions
 * in the ScriptExecutor since they need async handling.
 */
export function installBuiltins(sandbox: LuaSandbox, options: BuiltinsOptions = {}): void {
  const {
    logFn = (...args: unknown[]) => console.log('[Script]', ...args),
    enableJson = true,
    enableLog = true,
  } = options;

  const L = (sandbox as any).L;

  // Install log function
  if (enableLog) {
    installLog(L, logFn);
  }

  // Install json library
  if (enableJson) {
    installJson(L);
  }
}

/**
 * Install the log function
 *
 * Uses fengari-interop's js.global to access a JavaScript function.
 * The sandbox already sets up the 'js' global via interop.luaopen_js().
 */
function installLog(L: any, logFn: (...args: unknown[]) => void): void {
  // Store the log function on globalThis so Lua can access it via js.global
  // Return true to prevent fengari-interop from throwing on undefined return
  (globalThis as any).__connectome_script_log = (msg: string) => {
    logFn(msg);
    return true;
  };

  // Create a Lua function that calls the JS function via js.global
  // Note: fengari-interop requires method call syntax (:) to pass arguments
  const logCode = `
    -- Create log function that calls JS via fengari-interop
    function log(...)
      local n = select('#', ...)  -- Get actual count including nils
      local strs = {}
      for i = 1, n do
        local v = select(i, ...)
        if type(v) == 'table' then
          strs[i] = _json_stringify_internal and _json_stringify_internal(v) or tostring(v)
        else
          strs[i] = tostring(v)
        end
      end
      local msg = table.concat(strs, ' ')

      -- Use method call syntax (:) to properly pass arguments via fengari-interop
      -- Wrap in pcall to handle any fengari-interop quirks
      local ok, err = pcall(function()
        js.global:__connectome_script_log(msg)
      end)
      -- Ignore errors - the log already happened if we got this far
    end

    -- Also override print to use our log
    print = log
  `;

  // Execute the Lua code to set up the log function
  const status = lauxlib.luaL_dostring(L, to_luastring(logCode));
  if (status !== LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_pop(L, 1);
    throw new Error(`Failed to install log function: ${err}`);
  }
}

/**
 * Install the json library (encode/decode)
 */
function installJson(L: any): void {
  // Create json table and functions
  // Note: In Lua, local functions must be forward-declared or use a table to allow mutual recursion
  const jsonCode = `
    json = {}

    -- Internal stringify for tables
    function _json_stringify_internal(t, indent)
      indent = indent or 0
      local result = {}

      if type(t) ~= 'table' then
        if type(t) == 'string' then
          return '"' .. t:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"'):gsub('\\n', '\\\\n'):gsub('\\r', '\\\\r'):gsub('\\t', '\\\\t') .. '"'
        elseif type(t) == 'boolean' or type(t) == 'number' then
          return tostring(t)
        elseif t == nil then
          return 'null'
        else
          return '"' .. tostring(t) .. '"'
        end
      end

      -- Check if it's an array (sequential integer keys starting from 1)
      local isArray = true
      local maxIndex = 0
      for k, v in pairs(t) do
        if type(k) ~= 'number' or k < 1 or k ~= math.floor(k) then
          isArray = false
          break
        end
        if k > maxIndex then maxIndex = k end
      end
      -- Also check for holes
      if isArray and maxIndex > 0 then
        for i = 1, maxIndex do
          if t[i] == nil then
            isArray = false
            break
          end
        end
      end

      if isArray and maxIndex > 0 then
        -- Array
        for i = 1, maxIndex do
          table.insert(result, _json_stringify_internal(t[i], indent + 1))
        end
        return '[' .. table.concat(result, ',') .. ']'
      else
        -- Object
        local isEmpty = true
        for k, v in pairs(t) do
          isEmpty = false
          local key = type(k) == 'string' and k or tostring(k)
          table.insert(result, '"' .. key .. '":' .. _json_stringify_internal(v, indent + 1))
        end
        if isEmpty then
          return '{}'
        end
        return '{' .. table.concat(result, ',') .. '}'
      end
    end

    function json.encode(t)
      return _json_stringify_internal(t)
    end

    -- JSON decoder using a parser object to handle mutual recursion
    function json.decode(s)
      local parser = {}
      parser.pos = 1
      parser.len = #s
      parser.s = s

      function parser:skip_ws()
        while self.pos <= self.len do
          local c = self.s:sub(self.pos, self.pos)
          if c ~= ' ' and c ~= '\\t' and c ~= '\\n' and c ~= '\\r' then
            break
          end
          self.pos = self.pos + 1
        end
      end

      function parser:parse_string()
        self.pos = self.pos + 1 -- skip opening quote
        local result = {}
        while self.pos <= self.len do
          local c = self.s:sub(self.pos, self.pos)
          if c == '"' then
            self.pos = self.pos + 1
            return table.concat(result)
          elseif c == '\\\\' then
            self.pos = self.pos + 1
            local escape = self.s:sub(self.pos, self.pos)
            if escape == 'n' then table.insert(result, '\\n')
            elseif escape == 'r' then table.insert(result, '\\r')
            elseif escape == 't' then table.insert(result, '\\t')
            elseif escape == '"' then table.insert(result, '"')
            elseif escape == '\\\\' then table.insert(result, '\\\\')
            else table.insert(result, escape)
            end
          else
            table.insert(result, c)
          end
          self.pos = self.pos + 1
        end
        error('Unterminated string')
      end

      function parser:parse_number()
        local start = self.pos
        if self.s:sub(self.pos, self.pos) == '-' then self.pos = self.pos + 1 end
        while self.pos <= self.len and self.s:sub(self.pos, self.pos):match('[0-9]') do self.pos = self.pos + 1 end
        if self.pos <= self.len and self.s:sub(self.pos, self.pos) == '.' then
          self.pos = self.pos + 1
          while self.pos <= self.len and self.s:sub(self.pos, self.pos):match('[0-9]') do self.pos = self.pos + 1 end
        end
        if self.pos <= self.len and self.s:sub(self.pos, self.pos):match('[eE]') then
          self.pos = self.pos + 1
          if self.pos <= self.len and self.s:sub(self.pos, self.pos):match('[+-]') then self.pos = self.pos + 1 end
          while self.pos <= self.len and self.s:sub(self.pos, self.pos):match('[0-9]') do self.pos = self.pos + 1 end
        end
        return tonumber(self.s:sub(start, self.pos - 1))
      end

      function parser:parse_array()
        self.pos = self.pos + 1 -- skip [
        local arr = {}
        self:skip_ws()
        if self.s:sub(self.pos, self.pos) == ']' then
          self.pos = self.pos + 1
          return arr
        end
        while true do
          table.insert(arr, self:parse_value())
          self:skip_ws()
          local c = self.s:sub(self.pos, self.pos)
          if c == ']' then
            self.pos = self.pos + 1
            return arr
          elseif c == ',' then
            self.pos = self.pos + 1
          else
            error('Expected , or ] in array')
          end
        end
      end

      function parser:parse_object()
        self.pos = self.pos + 1 -- skip {
        local obj = {}
        self:skip_ws()
        if self.s:sub(self.pos, self.pos) == '}' then
          self.pos = self.pos + 1
          return obj
        end
        while true do
          self:skip_ws()
          if self.s:sub(self.pos, self.pos) ~= '"' then
            error('Expected string key in object')
          end
          local key = self:parse_string()
          self:skip_ws()
          if self.s:sub(self.pos, self.pos) ~= ':' then
            error('Expected : in object')
          end
          self.pos = self.pos + 1
          obj[key] = self:parse_value()
          self:skip_ws()
          local c = self.s:sub(self.pos, self.pos)
          if c == '}' then
            self.pos = self.pos + 1
            return obj
          elseif c == ',' then
            self.pos = self.pos + 1
          else
            error('Expected , or } in object')
          end
        end
      end

      function parser:parse_value()
        self:skip_ws()
        if self.pos > self.len then
          error('Unexpected end of JSON')
        end

        local c = self.s:sub(self.pos, self.pos)

        if c == '"' then
          return self:parse_string()
        elseif c == '{' then
          return self:parse_object()
        elseif c == '[' then
          return self:parse_array()
        elseif c == 't' then
          if self.s:sub(self.pos, self.pos + 3) == 'true' then
            self.pos = self.pos + 4
            return true
          end
        elseif c == 'f' then
          if self.s:sub(self.pos, self.pos + 4) == 'false' then
            self.pos = self.pos + 5
            return false
          end
        elseif c == 'n' then
          if self.s:sub(self.pos, self.pos + 3) == 'null' then
            self.pos = self.pos + 4
            return nil
          end
        elseif c == '-' or (c >= '0' and c <= '9') then
          return self:parse_number()
        end

        error('Invalid JSON at position ' .. self.pos)
      end

      return parser:parse_value()
    end
  `;

  const status = lauxlib.luaL_dostring(L, to_luastring(jsonCode));
  if (status !== LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_pop(L, 1);
    throw new Error(`Failed to install json library: ${err}`);
  }
}

/**
 * Get a list of all built-in function names
 */
export function getBuiltinNames(): string[] {
  return ['log', 'print', 'json'];
}
