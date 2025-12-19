import { state } from './store.js';
import { normalizeFrame, cloneFacetsTree, debugLog } from './utils.js';

let socket = null;
let reconnectTimer = null;
let frameLoadSequence = 0;
const frameDetailCache = new Map();

export function upsertFrame(frameData) {
  if (!frameData || !frameData.uuid) return;
  const incoming = normalizeFrame(frameData);
  const index = state.frames.findIndex(f => f.uuid === incoming.uuid);
  if (index === -1) {
    state.frames.push(incoming);
  } else {
    const existing = state.frames[index];
    state.frames[index] = {
      ...existing,
      ...incoming,
      events: incoming.events.length ? incoming.events : existing.events,
      deltas: incoming.deltas.length ? incoming.deltas : existing.deltas,
      components: incoming.components || existing.components,
      executions: incoming.executions || existing.executions,
      renderedContext: incoming.renderedContext || existing.renderedContext
    };
  }
  state.frames.sort((a, b) => b.sequence - a.sequence);
  state.framePagination.nextOffset = state.frames.length;
}

export function applyEventToFrame(frameId, eventRecord) {
  const index = state.frames.findIndex(f => f.uuid === frameId);
  if (index === -1) return;
  const frame = state.frames[index];
  const events = frame.events ? [...frame.events] : [];
  events.push(eventRecord);
  state.frames[index] = {
    ...frame,
    events
  };
  if (state.selectedFrameId === frameId) {
    state.selectedEventIndex = events.length - 1;
  }
}

export function applyDebugLLMRequests(requests) {
  if (!state.debugLLMEnabled) {
    state.debugLLMRequests = [];
    return;
  }
  if (!Array.isArray(requests)) return;
  const sorted = [...requests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  state.debugLLMRequests = sorted;
  ensureSelectedLLMRequest();
}

export function applyDebugLLMRequest(request) {
  if (!state.debugLLMEnabled) return;
  if (!request || !request.id) return;
  const existingIndex = state.debugLLMRequests.findIndex(item => item.id === request.id);
  let next = [];
  if (existingIndex === -1) {
    next = [request, ...state.debugLLMRequests];
  } else {
    next = [...state.debugLLMRequests];
    next[existingIndex] = { ...next[existingIndex], ...request };
  }
  next.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  state.debugLLMRequests = next;
  if (request.status && request.status !== 'pending' && state.selectedLLMRequestId === request.id) {
    state.llmSubmitError = null;
  }
  ensureSelectedLLMRequest();
}

export function ensureSelectedLLMRequest() {
  if (!state.debugLLMRequests.length) {
    state.selectedLLMRequestId = null;
    return;
  }
  if (state.selectedLLMRequestId) {
    const stillExists = state.debugLLMRequests.some(request => request.id === state.selectedLLMRequestId);
    if (stillExists) {
      return;
    }
  }
  const pending = state.debugLLMRequests.find(request => request.status === 'pending');
  const nextId = pending ? pending.id : state.debugLLMRequests[0]?.id || null;
  if (nextId) {
    selectLLMRequest(nextId);
  } else {
    state.selectedLLMRequestId = null;
  }
}

export function selectLLMRequest(requestId) {
  state.selectedLLMRequestId = requestId;
  state.llmSubmitError = null;
  if (requestId && state.llmResponseDrafts[requestId] === undefined) {
    state.llmResponseDrafts[requestId] = '';
  }
}

export function setDebugLLMEnabled(enabled) {
  if (state.debugLLMEnabled === enabled) {
    return;
  }
  state.debugLLMEnabled = enabled;
  if (!enabled) {
    state.debugLLMRequests = [];
    state.selectedLLMRequestId = null;
    state.llmResponseDrafts = {};
    state.llmModelOverrides = {};
    state.llmSubmitError = null;
    state.llmSubmitting = false;
  }
}

export async function setTracingEnabled(enabled) {
  try {
    const response = await fetch('/api/config/tracing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!response.ok) throw new Error('Failed to toggle tracing');
    const payload = await response.json();
    state.tracingEnabled = payload.enabled;
  } catch (err) {
    state.error = err.message;
  }
}

export async function loadDebugLLMRequests() {
  if (!state.debugLLMEnabled) {
    state.debugLLMRequests = [];
    return;
  }
  try {
    const response = await fetch('/api/debug-llm/requests');
    if (!response.ok) throw new Error(`debug llm requests failed: ${response.status}`);
    const payload = await response.json();
    if (payload && payload.enabled === false) {
      setDebugLLMEnabled(false);
      return;
    }
    if (payload && payload.enabled === true && !state.debugLLMEnabled) {
      setDebugLLMEnabled(true);
    }
    applyDebugLLMRequests(payload.requests || []);
  } catch (err) {
    console.warn('Failed to load manual LLM requests', err);
  }
}

export async function submitLLMResponse(requestId) {
  const targetId = requestId || state.selectedLLMRequestId;
  if (!targetId) return;
  const draft = state.llmResponseDrafts[targetId];
  if (!draft || !draft.trim()) {
    state.llmSubmitError = 'Response content is required.';
    return;
  }

  state.llmSubmitting = true;
  state.llmSubmitError = null;

  try {
    const payload = {
      content: draft.trim()
    };
    const overrideModel = state.llmModelOverrides[targetId];
    if (overrideModel && overrideModel.trim()) {
      payload.modelId = overrideModel.trim();
    }

    const response = await fetch(`/api/debug-llm/requests/${targetId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to submit response');
    }

    if (result.request) {
      applyDebugLLMRequest(result.request);
    }

    delete state.llmResponseDrafts[targetId];
    delete state.llmModelOverrides[targetId];
    ensureSelectedLLMRequest();
  } catch (err) {
    state.llmSubmitError = err.message || 'Failed to submit response';
  } finally {
    state.llmSubmitting = false;
  }
}

export async function loadFrames({ reset = false, append = false } = {}) {
  if (state.framePagination.loading) {
    debugLog('loadFrames skip (already loading)', { reset, append });
    return;
  }
  const { limit, nextOffset } = state.framePagination;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  const offset = append ? nextOffset : 0;
  if (append && offset > 0) {
    params.set('offset', String(offset));
  }

  if (reset) {
    debugLog('loadFrames reset state');
    state.frames = [];
    state.framePagination.nextOffset = 0;
    state.framePagination.hasMore = true;
    frameDetailCache.clear();
    state.frameFacets = [];
    state.frameFacetsSequence = null;
  }

  state.framePagination.loading = true;
  debugLog('loadFrames request', { reset, append, limit, offset, url: `/api/frames?${params.toString()}` });
  let frames = [];

  try {
    const response = await fetch(`/api/frames?${params.toString()}`);
    if (!response.ok) throw new Error(`frames request failed: ${response.status}`);
    const payload = await response.json();
    frames = payload.frames || [];
    frames.forEach(upsertFrame);
    state.metrics = {
      ...state.metrics,
      ...(payload.metrics || {})
    };
    state.lastUpdated = new Date().toISOString();
    if (append) {
      if (frames.length < limit) {
        state.framePagination.hasMore = false;
      }
    } else {
      state.framePagination.hasMore = frames.length === limit;
    }
  } catch (err) {
    state.error = `Failed to load frames: ${err.message}`;
    debugLog('loadFrames error', { error: err });
  } finally {
    state.framePagination.loading = false;
    debugLog('loadFrames complete', {
      reset,
      append,
      received: frames.length,
      totalFrames: state.frames.length,
      hasMore: state.framePagination.hasMore
    });
  }
}

export function initializeElementExpansion(node, depth = 0, expandedElements) {
  if (!node) return;
  if (expandedElements[node.id] === undefined) {
    expandedElements[node.id] = depth < 1;
  }
  if (node.children) {
    node.children.forEach(child => initializeElementExpansion(child, depth + 1, expandedElements));
  }
}

export async function loadSystemState(expandedElements) {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`state request failed: ${response.status}`);
    const payload = await response.json();
    state.elementTree = payload.space || null;
    if (state.elementTree && expandedElements) {
      initializeElementExpansion(state.elementTree, 0, expandedElements);
    }
    // Extract components from space
    if (payload.space?.components && Array.isArray(payload.space.components)) {
      state.components = payload.space.components.map((c, index) => ({
        index,
        id: c.id,
        name: c.constructor?.name || c.name || 'Unknown',
        priority: c.priority,
        enabled: c.enabled
      }));
    } else {
      state.components = [];
    }
    if (payload.metrics) {
      state.metrics = {
        ...state.metrics,
        ...payload.metrics
      };
    }
    if (typeof payload.manualLLMEnabled === 'boolean') {
      const wasEnabled = state.debugLLMEnabled;
      setDebugLLMEnabled(payload.manualLLMEnabled);
      if (payload.manualLLMEnabled && !wasEnabled) {
        await loadDebugLLMRequests();
      }
    }
    if (typeof payload.tracingEnabled === 'boolean') {
      state.tracingEnabled = payload.tracingEnabled;
    }
  } catch (err) {
    state.error = `Failed to load system state: ${err.message}`;
  }
}

export async function fetchFrameDetail(uuid) {
  if (!uuid) return null;

  const requestId = ++frameLoadSequence;
  const showSpinner = state.selectedFrameId === uuid;
  if (showSpinner) {
    state.loadingFrame = true;
  }

  debugLog('fetchFrameDetail start', {
    uuid,
    requestId,
    selectedFrameId: state.selectedFrameId,
    showSpinner
  });

  try {
    const response = await fetch(`/api/frames/${uuid}`);
    if (!response.ok) throw new Error(`frame request failed: ${response.status}`);
    const payload = await response.json();
    debugLog('fetchFrameDetail raw payload', {
      uuid,
      payloadKeys: Object.keys(payload || {}),
      facetsSequence: payload.facetsSequence
    });

    // Use new veilState structure (historical state at this frame)
    const veilState = payload.veilState || {};
    const facetsTree = veilState.facets || [];
    const sequence = veilState.sequence ?? null;
    
    frameDetailCache.set(uuid, {
      facetsTree,
      sequence
    });
    debugLog('fetchFrameDetail response', {
      uuid,
      requestId,
      facetsCount: facetsTree.length,
      veilSequence: sequence,
      frameLoadSequence,
      selectedFrameId: state.selectedFrameId
    });

    upsertFrame(payload);

    if (requestId === frameLoadSequence && state.selectedFrameId === uuid) {
      state.frameFacets = cloneFacetsTree(facetsTree);
      state.frameFacetsSequence = sequence;
      debugLog('fetchFrameDetail applied to state', {
        uuid,
        facetsCount: facetsTree.length,
        facets: facetsTree.map(f => ({
          id: f.id,
          type: f.type,
          displayName: f.displayName,
          content: f.content,
          children: f.children?.length || 0,
          facetsSequence: payload.facetsSequence
        })),
        facetsSequence: payload.facetsSequence
      });
    } else {
      debugLog('fetchFrameDetail ignored (stale request)', {
        uuid,
        requestId,
        frameLoadSequence,
        selectedFrameId: state.selectedFrameId
      });
    }

    return payload;
  } catch (err) {
    if (requestId === frameLoadSequence && state.selectedFrameId === uuid) {
      state.error = `Failed to load frame ${uuid}: ${err.message}`;
    }
    debugLog('fetchFrameDetail error', { uuid, error: err });
    throw err;
  } finally {
    if (showSpinner && requestId === frameLoadSequence && state.selectedFrameId === uuid) {
      state.loadingFrame = false;
    }
    debugLog('fetchFrameDetail complete', {
      uuid,
      requestId,
      selectedFrameId: state.selectedFrameId,
      loading: state.loadingFrame
    });
  }
}

export async function setSelectedFrame(uuid, { forceReload = false } = {}) {
  if (!uuid) {
    state.selectedFrameId = null;
    state.selectedOperationIndex = null;
    state.selectedEventIndex = null;
    state.activeDetail = null;
    state.frameFacets = [];
    state.frameFacetsSequence = null;
    state.loadingFrame = false;
    debugLog('setSelectedFrame cleared');
    return;
  }

  const changed = state.selectedFrameId !== uuid;
  state.selectedFrameId = uuid;
  debugLog('setSelectedFrame', {
    uuid,
    forceReload,
    changed,
    cached: frameDetailCache.has(uuid),
    cachedFacets: frameDetailCache.get(uuid)?.facetsTree?.length || 0
  });

  const frame = state.frames.find(f => f.uuid === uuid);
  if (changed) {
    state.selectedOperationIndex = frame?.deltas?.length ? 0 : null;
    state.selectedEventIndex = frame?.events?.length ? 0 : null;
  } else {
    if (frame?.deltas?.length) {
      if (state.selectedOperationIndex == null) {
        state.selectedOperationIndex = 0;
      } else if (state.selectedOperationIndex >= frame.deltas.length) {
        state.selectedOperationIndex = frame.deltas.length - 1;
      }
    } else {
      state.selectedOperationIndex = null;
    }

    if (frame?.events?.length) {
      if (state.selectedEventIndex == null) {
        state.selectedEventIndex = 0;
      } else if (state.selectedEventIndex >= frame.events.length) {
        state.selectedEventIndex = frame.events.length - 1;
      }
    } else {
      state.selectedEventIndex = null;
    }
  }
  state.activeDetail = null;

  const cached = frameDetailCache.get(uuid);
  if (cached && !forceReload) {
    state.frameFacets = cloneFacetsTree(cached.facetsTree || []);
    state.frameFacetsSequence = cached.sequence ?? null;
    debugLog('setSelectedFrame using cached facets', {
      uuid,
      facetsCount: cached.facetsTree?.length || 0,
      facets: cached.facetsTree?.map(f => ({
        id: f.id,
        type: f.type,
        displayName: f.displayName,
        content: f.content,
        children: f.children?.length || 0,
        sequence: cached.sequence ?? null
      }))
    });
  } else {
    state.frameFacets = [];
    state.frameFacetsSequence = null;
    debugLog('setSelectedFrame cleared facets pending fetch', { uuid, forceReload, cached: !!cached });
  }

  if (!cached || forceReload || changed) {
    try {
      await fetchFrameDetail(uuid);
    } catch (err) {
      // error already surfaced via state.error
      debugLog('setSelectedFrame fetch failed', { uuid, error: err });
    }
  }
}

export async function refresh(expandedElements) {
  state.error = null;
  debugLog('refresh start', { existingFrames: state.frames.length, selectedFrameId: state.selectedFrameId });
  const tasks = [
    loadFrames({ reset: true }),
    loadSystemState(expandedElements)
  ];
  if (state.debugLLMEnabled) {
    tasks.push(loadDebugLLMRequests());
  }
  await Promise.all(tasks);
  if (!state.frames.length) {
    await setSelectedFrame(null);
    return;
  }

  const hasSelected = state.selectedFrameId && state.frames.some(f => f.uuid === state.selectedFrameId);
  const initialId = hasSelected ? state.selectedFrameId : state.frames[0].uuid;
  debugLog('refresh selecting initial frame', { initialId, hasSelected, framesLoaded: state.frames.length });
  await setSelectedFrame(initialId, { forceReload: true });
  debugLog('refresh complete', { selectedFrameId: state.selectedFrameId });
}

export async function activateAgent() {
  try {
      // Get active agents from current state
      const agents = Array.from(state.veilState?.agents?.values() || []);

      // If there's only one agent, target it specifically
      const targetAgentId = agents.length === 1 ? agents[0].id : undefined;
      const targetAgent = agents.length === 1 ? agents[0].name : undefined;

      // Use semantic event instead of veil:operation
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'debug:request-activation',
          sourceId: 'debug-ui',
          payload: {
            reason: 'Manual activation from Debug UI',
            priority: 'high',
            targetAgentId,
            targetAgent,
            streamId: 'console:debug-ui'
          }
        })
      });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to activate agent');
    }

    console.log('Agent activation requested via debug:request-activation', {
      targetAgentId,
      targetAgent
    });

    // Wait a moment for the frame to be created
    setTimeout(() => refresh(), 500);
  } catch (error) {
    console.error('Failed to activate agent:', error);
    state.error = error.message;
  }
}

export async function confirmDelete() {
  if (!state.deleteCount || state.deleteCount > state.frames.length) return;
  
  state.deleting = true;
  state.deleteError = null;
  
  try {
    const response = await fetch('/api/frames/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: state.deleteCount })
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || 'Failed to delete frames');
    }
    
    // Return success to allow UI to close dialog
    state.deleting = false;
    return result;
    
  } catch (error) {
    state.deleteError = error.message || 'Frame deletion failed';
    console.error('Frame deletion error:', error);
    state.deleting = false;
    throw error;
  }
}

export async function performInjection() {
  state.injecting = true;
  state.injectError = null;

  try {
    // Parse the JSON payload
    let payload;
    try {
      payload = JSON.parse(state.injectionPayload);
    } catch (parseError) {
      throw new Error(`Invalid JSON: ${parseError.message}`);
    }

    // Validate required fields
    if (!payload.topic) {
      throw new Error('Payload must include a "topic" field');
    }

    // Send to debug server
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to inject event');
    }

    console.log('Event injected successfully', payload);

    // Wait a moment for the frame to be created
    setTimeout(() => refresh(), 500);
    
    return true; // Success

  } catch (error) {
    state.injectError = error.message || 'Injection failed';
    console.error('Injection error:', error);
    throw error;
  } finally {
    state.injecting = false;
  }
}

export function handleSocketMessage(message) {
  debugLog('handleSocketMessage', { type: message.type });
  switch (message.type) {
    case 'hello': {
      const manualEnabled = Boolean(message.payload?.manualLLMEnabled);
      setDebugLLMEnabled(manualEnabled);
      if (manualEnabled) {
        applyDebugLLMRequests(message.payload?.debugLLMRequests || []);
      }
      (message.payload?.frames || []).forEach(upsertFrame);
      if (message.payload?.metrics) {
        state.metrics = {
          ...state.metrics,
          ...message.payload.metrics
        };
      }
      if (Array.isArray(message.payload?.debugLLMRequests)) {
        applyDebugLLMRequests(message.payload.debugLLMRequests);
      }
      if (!state.selectedFrameId && state.frames.length) {
        setSelectedFrame(state.frames[0].uuid, { forceReload: true });
      }
      break;
    }
    case 'frame:start':
    case 'frame:complete':
    case 'frame:outgoing':
    case 'frame:context': {
      if (message.payload?.uuid) {
        debugLog('handleSocketMessage invalidate cache', { uuid: message.payload.uuid });
        frameDetailCache.delete(message.payload.uuid);
      }
      upsertFrame(message.payload);
      if (!state.selectedFrameId && state.frames.length) {
        setSelectedFrame(state.frames[0].uuid, { forceReload: true });
      } else if (message.payload?.uuid && message.payload.uuid === state.selectedFrameId) {
        setSelectedFrame(state.selectedFrameId, { forceReload: true });
      }
      break;
    }
    case 'frame:event': {
      const { frameId, event } = message.payload || {};
      if (frameId && event) {
        debugLog('handleSocketMessage frame:event', {
          frameId,
          eventTopic: event.topic,
          selectedFrameId: state.selectedFrameId
        });
        frameDetailCache.delete(frameId);
        applyEventToFrame(frameId, event);
        if (frameId === state.selectedFrameId) {
          setSelectedFrame(state.selectedFrameId, { forceReload: true });
        }
      }
      break;
    }
    case 'frame-deletion': {
      // Handle frame deletion notification
      console.log('Frame deletion completed:', message.payload);
      if (message.payload?.deletedCount) {
        // Show a temporary notification
        const msg = `Deleted ${message.payload.deletedCount} frames, reverted to sequence ${message.payload.afterSequence}`;
        console.log(msg);
        // Refresh to get updated state
        refresh();
      }
      break;
    }
    case 'debugLLM:request-created':
    case 'debugLLM:request-updated': {
      applyDebugLLMRequest(message.payload);
      break;
    }
    case 'debugLLM:enabled': {
      const wasEnabled = state.debugLLMEnabled;
      const enabled = Boolean(message.payload?.enabled);
      setDebugLLMEnabled(enabled);
      if (enabled && !wasEnabled) {
        loadDebugLLMRequests();
      }
      break;
    }
    default:
      break;
  }
}

export function connectSocket() {
  if (socket) {
    socket.close();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}`);
  
  debugLog('connectSocket', { url: `${protocol}://${window.location.host}` });

  socket.addEventListener('open', () => {
    state.connectionStatus = 'live';
    state.error = null;
    debugLog('socket open');
  });

  socket.addEventListener('close', () => {
    state.connectionStatus = 'offline';
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(connectSocket, 2000);
    debugLog('socket close - will retry');
  });

  socket.addEventListener('message', event => {
    try {
      const payload = JSON.parse(event.data);
      debugLog('socket message', payload?.type ? { type: payload.type } : {});
      handleSocketMessage(payload);
    } catch (err) {
      console.warn('Failed to process debug message', err);
    }
  });
}

export function cleanupSocket() {
  if (socket) {
    socket.close();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
}
