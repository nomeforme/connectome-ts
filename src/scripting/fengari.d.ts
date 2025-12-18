/**
 * Type declarations for fengari and fengari-interop
 *
 * Fengari is a Lua VM written in JavaScript.
 * These are minimal declarations covering the APIs we use.
 */

declare module 'fengari' {
  export const lua: {
    // Constants
    LUA_OK: number;
    LUA_YIELD: number;
    LUA_ERRRUN: number;
    LUA_ERRSYNTAX: number;
    LUA_ERRMEM: number;
    LUA_ERRERR: number;

    // Types
    LUA_TNIL: number;
    LUA_TBOOLEAN: number;
    LUA_TLIGHTUSERDATA: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
    LUA_TFUNCTION: number;
    LUA_TUSERDATA: number;
    LUA_TTHREAD: number;

    // State management
    lua_close(L: LuaState): void;
    lua_newthread(L: LuaState): LuaState;

    // Stack manipulation
    lua_gettop(L: LuaState): number;
    lua_settop(L: LuaState, index: number): void;
    lua_pop(L: LuaState, n: number): void;
    lua_pushnil(L: LuaState): void;
    lua_pushboolean(L: LuaState, b: number): void;
    lua_pushnumber(L: LuaState, n: number): void;
    lua_pushstring(L: LuaState, s: Uint8Array): void;
    lua_pushvalue(L: LuaState, index: number): void;

    // Type checking
    lua_type(L: LuaState, index: number): number;
    lua_typename(L: LuaState, tp: number): Uint8Array;
    lua_isnil(L: LuaState, index: number): boolean;
    lua_isnumber(L: LuaState, index: number): boolean;
    lua_isstring(L: LuaState, index: number): boolean;

    // Value retrieval
    lua_toboolean(L: LuaState, index: number): number;
    lua_tonumber(L: LuaState, index: number): number;
    lua_tostring(L: LuaState, index: number): Uint8Array;

    // Table operations
    lua_newtable(L: LuaState): void;
    lua_settable(L: LuaState, index: number): void;
    lua_gettable(L: LuaState, index: number): number;
    lua_rawget(L: LuaState, index: number): number;
    lua_rawset(L: LuaState, index: number): void;
    lua_rawgeti(L: LuaState, index: number, n: number): number;
    lua_rawseti(L: LuaState, index: number, n: number): void;
    lua_rawlen(L: LuaState, index: number): number;
    lua_next(L: LuaState, index: number): number;

    // Global operations
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_getglobal(L: LuaState, name: Uint8Array): number;

    // Coroutine operations
    lua_resume(L: LuaState, from: LuaState | null, nargs: number): number;
    lua_yield(L: LuaState, nresults: number): number;
    lua_status(L: LuaState): number;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadstring(L: LuaState, s: Uint8Array): number;
    luaL_dostring(L: LuaState, s: Uint8Array): number;
    luaL_requiref(L: LuaState, modname: Uint8Array, openf: (L: LuaState) => number, glb: number): void;
    luaL_ref(L: LuaState, t: number): number;
    luaL_unref(L: LuaState, t: number, ref: number): void;
  };

  export const lualib: {
    luaopen_base(L: LuaState): number;
    luaopen_table(L: LuaState): number;
    luaopen_string(L: LuaState): number;
    luaopen_math(L: LuaState): number;
    luaopen_utf8(L: LuaState): number;
    luaopen_coroutine(L: LuaState): number;
    luaopen_os(L: LuaState): number;
    luaopen_io(L: LuaState): number;
    luaopen_debug(L: LuaState): number;
    luaopen_package(L: LuaState): number;
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(str: string, cache?: boolean): Uint8Array;
  export function to_jsstring(arr: Uint8Array | null): string;

  // Opaque type for Lua state
  export type LuaState = object;
}

declare module 'fengari-interop' {
  import { LuaState } from 'fengari';

  export function luaopen_js(L: LuaState): number;
  export function push(L: LuaState, value: unknown): void;
  export function tojs(L: LuaState, index: number): unknown;
}
