export { DebugServer } from './debug-server';
export type { DebugServerConfig } from './debug-server';
export type { DebugObserver } from './types';
export {
  registerDebugHost,
  registerDebugSpace,
  registerDebugServer,
  registerDebugAgent,
  getDebugRegistry,
  isDebugRegistryActive
} from './debug-registry';
