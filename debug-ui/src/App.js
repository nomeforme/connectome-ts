import { computed, onMounted, onBeforeUnmount, watch, nextTick, ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import { state } from './store.js';
import * as api from './api.js';
import {
  formatTime,
  formatTimestamp,
  shorten,
  truncate,
  formatChildren,
  summarizeFacet,
  summarizeOperation,
  summarizeEvent,
  operationMeta,
  eventMeta,
  stringify,
  extractActionSnippets,
  getTurnLabel
} from './utils.js';
import { JsonViewer } from './components/JsonViewer.js';
import { FacetTree, InlineFacetTree } from './components/FacetTree.js';
import { ElementTree } from './components/ElementTree.js';

export const App = {
  components: {
    JsonViewer,
    FacetTree,
    InlineFacetTree,
    ElementTree
  },
  setup() {
    const layoutRef = ref(null);
    const sidebarRef = ref(null);
    const isResizingInspector = ref(false);
    const isResizingSidebar = ref(false);
    const isResizingSidebarPanels = ref(false);
    let sidebarResizeState = { startX: 0, startWidth: 0 };
    let sidebarPanelResizeState = { startY: 0, startHeight: 0 };

    // UI Logic
    const filteredFrames = computed(() => {
      const query = state.filters.search.trim().toLowerCase();
      const source = state.frames || [];
      if (!query) return source;
      return source.filter(frame => {
        if (frame.uuid && frame.uuid.toLowerCase().includes(query)) return true;
        if (frame.sequence && String(frame.sequence).includes(query)) return true;
        if (frame.activeStream?.streamId && frame.activeStream.streamId.toLowerCase().includes(query)) return true;
        if (frame.agent?.name && frame.agent.name.toLowerCase().includes(query)) return true;
        if (frame.agent?.id && frame.agent.id.toLowerCase().includes(query)) return true;
        if (frame.reason && String(frame.reason).toLowerCase().includes(query)) return true;
        return false;
      });
    });

    // Group consecutive streaming frames for collapsed display
    const groupedFrames = computed(() => {
      const frames = filteredFrames.value;
      const groups = [];
      let streamingBuffer = [];

      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const isStreaming = frame.kind === 'in-stream' || frame.kind === 'out-stream';

        if (isStreaming) {
          streamingBuffer.push(frame);
        } else {
          // Flush streaming buffer
          if (streamingBuffer.length > 0) {
            if (streamingBuffer.length === 1) {
              groups.push({ type: 'single', frame: streamingBuffer[0] });
            } else {
              // Group streaming frames by activationId
              const activationId = streamingBuffer[0].streamingActivationId;
              const reconstructed = reconstructAccumulatedContent(streamingBuffer);
              groups.push({
                type: 'streaming-group',
                frames: streamingBuffer,
                count: streamingBuffer.length,
                activationId,
                kind: streamingBuffer[0].kind,
                firstSequence: streamingBuffer[streamingBuffer.length - 1].sequence,
                lastSequence: streamingBuffer[0].sequence,
                reconstructedContent: reconstructed
              });
            }
            streamingBuffer = [];
          }
          groups.push({ type: 'single', frame });
        }
      }

      // Flush remaining streaming buffer
      if (streamingBuffer.length > 0) {
        if (streamingBuffer.length === 1) {
          groups.push({ type: 'single', frame: streamingBuffer[0] });
        } else {
          const activationId = streamingBuffer[0].streamingActivationId;
          const reconstructed = reconstructAccumulatedContent(streamingBuffer);
          groups.push({
            type: 'streaming-group',
            frames: streamingBuffer,
            count: streamingBuffer.length,
            activationId,
            kind: streamingBuffer[0].kind,
            firstSequence: streamingBuffer[streamingBuffer.length - 1].sequence,
            lastSequence: streamingBuffer[0].sequence,
            reconstructedContent: reconstructed
          });
        }
      }

      return groups;
    });

    // Reconstruct accumulated content from streaming frames
    function reconstructAccumulatedContent(streamingFrames) {
      // Frames are in descending order by sequence, so reverse for chronological order
      const chronological = [...streamingFrames].reverse();
      let accumulated = '';
      for (const frame of chronological) {
        // Get chunk from the first event's payload
        const event = frame.events?.[0];
        if (event?.payload?.chunk) {
          accumulated += event.payload.chunk;
        }
      }
      return accumulated;
    }

    // Track expanded streaming groups
    const expandedStreamingGroups = ref(new Set());

    function toggleStreamingGroup(groupKey) {
      if (expandedStreamingGroups.value.has(groupKey)) {
        expandedStreamingGroups.value.delete(groupKey);
      } else {
        expandedStreamingGroups.value.add(groupKey);
      }
      expandedStreamingGroups.value = new Set(expandedStreamingGroups.value);
    }

    function isStreamingGroupExpanded(groupKey) {
      return expandedStreamingGroups.value.has(groupKey);
    }

    const selectedFrame = computed(() => {
      if (!state.selectedFrameId) return null;
      return state.frames.find(frame => frame.uuid === state.selectedFrameId) || null;
    });

    const selectedOperation = computed(() => {
      const frame = selectedFrame.value;
      if (!frame || state.selectedOperationIndex == null) return null;
      return frame.deltas?.[state.selectedOperationIndex] || null;
    });

    const selectedEvent = computed(() => {
      const frame = selectedFrame.value;
      if (!frame || state.selectedEventIndex == null) return null;
      return frame.events?.[state.selectedEventIndex] || null;
    });

    const timelineFrames = computed(() => {
      const frames = [...state.frames];
      frames.sort((a, b) => b.sequence - a.sequence);
      return frames.slice(0, 24);
    });

    const processedVeilFacets = computed(() => {
      if (!state.frameFacets || state.frameFacets.length === 0) {
        return { turns: [], reversed: [] };
      }
      const reversed = [...state.frameFacets].reverse();
      const turns = [];
      let currentTurn = null;
      const turnCounters = new Map();

      for (const facet of reversed) {
        const isAgentGenerated = facet.attributes?.agentGenerated === true;
        const facetType = facet.type;
        let turnType;
        if (isAgentGenerated) {
          if (facetType === 'speech') turnType = 'agent-speech';
          else if (facetType === 'action') turnType = 'agent-action';
          else if (facetType === 'thought') turnType = 'agent-thought';
          else turnType = 'agent-other';
        } else {
          if (facetType === 'event') turnType = 'external-event';
          else if (facetType === 'state') turnType = 'state-update';
          else turnType = 'external-other';
        }

        if (!currentTurn || currentTurn.type !== turnType) {
          const currentCount = turnCounters.get(turnType) || 0;
          turnCounters.set(turnType, currentCount + 1);
          currentTurn = {
            type: turnType,
            label: getTurnLabel(turnType, currentCount + 1),
            facets: []
          };
          turns.push(currentTurn);
        }
        currentTurn.facets.push(facet);
      }

      const maxCounters = new Map();
      for (const [turnType, count] of turnCounters) {
        maxCounters.set(turnType, count);
      }
      
      const reversedCounters = new Map();
      for (const turn of turns) {
        const maxCount = maxCounters.get(turn.type);
        const currentReversedCount = reversedCounters.get(turn.type) || 0;
        const reversedNumber = maxCount - currentReversedCount;
        reversedCounters.set(turn.type, currentReversedCount + 1);
        turn.label = getTurnLabel(turn.type, reversedNumber);
      }

      return { turns, reversed };
    });

    const availableActions = computed(() => {
      if (!state.frameFacets || state.frameFacets.length === 0) return [];
      const snippets = extractActionSnippets(state.frameFacets);
      if (!snippets.length) return [];
      const sorted = [...snippets].sort((a, b) => a.text.localeCompare(b.text));
      return sorted.slice(0, 30);
    });

    const pendingLLMRequests = computed(() => {
      if (!state.debugLLMEnabled) return [];
      return state.debugLLMRequests.filter(request => request.status === 'pending');
    });

    const selectedLLMRequest = computed(() => {
      if (!state.debugLLMEnabled || !state.selectedLLMRequestId) return null;
      return state.debugLLMRequests.find(request => request.id === state.selectedLLMRequestId) || null;
    });

    const framesToDelete = computed(() => {
      if (!state.deleteCount || state.deleteCount <= 0) return [];
      return state.frames.slice(0, state.deleteCount);
    });

    const componentOperations = computed(() => {
      if (!selectedFrame.value) return [];

      const frame = selectedFrame.value;
      const executions = frame.executions || [];
      const deltas = frame.deltas || [];
      const components = frame.components || [];

      // If no executions, show all deltas as ungrouped
      if (executions.length === 0) {
        return [{
          componentName: 'All Components',
          componentId: 'all',
          operations: deltas,
          deltaCount: deltas.length
        }];
      }

      // Group deltas by component execution
      return executions.map(exec => {
        const componentDeltas = deltas.slice(exec.deltaStartIndex, exec.deltaEndIndex);

        // Find matching component snapshot for full details
        const componentSnapshot = components.find(c => c.id === exec.componentId);

        return {
          componentName: exec.componentName,
          componentId: exec.componentId,
          operations: componentDeltas,
          deltaCount: componentDeltas.length,
          durationMs: exec.durationMs,
          emittedEvents: exec.emittedEvents,
          error: exec.error,
          context: exec.context,
          emittedEventDetails: exec.emittedEventDetails,
          componentSnapshot: componentSnapshot
        };
      });
    });

    // Group components preserving execution order, collapsing consecutive inactive components
    const groupedComponents = computed(() => {
      const ops = componentOperations.value;
      const groups = [];
      let inactiveBuffer = [];

      for (let i = 0; i < ops.length; i++) {
        const comp = ops[i];
        const isActive = comp.deltaCount > 0 || comp.emittedEvents > 0;

        if (isActive) {
          // Flush inactive buffer first
          if (inactiveBuffer.length > 0) {
            if (inactiveBuffer.length === 1) {
              // Single inactive: show directly but grayed out
              groups.push({ type: 'single-inactive', component: inactiveBuffer[0] });
            } else {
              // Multiple inactive: create collapsible group
              groups.push({ type: 'inactive-group', components: inactiveBuffer, count: inactiveBuffer.length });
            }
            inactiveBuffer = [];
          }
          // Add active component
          groups.push({ type: 'active', component: comp });
        } else {
          // Buffer inactive component
          inactiveBuffer.push(comp);
        }
      }

      // Flush remaining inactive buffer at end
      if (inactiveBuffer.length > 0) {
        if (inactiveBuffer.length === 1) {
          groups.push({ type: 'single-inactive', component: inactiveBuffer[0] });
        } else {
          groups.push({ type: 'inactive-group', components: inactiveBuffer, count: inactiveBuffer.length });
        }
      }

      return groups;
    });

    const expandedInactiveGroups = ref(new Set());

    function toggleInactiveGroup(groupIndex) {
      if (expandedInactiveGroups.value.has(groupIndex)) {
        expandedInactiveGroups.value.delete(groupIndex);
      } else {
        expandedInactiveGroups.value.add(groupIndex);
      }
      // Trigger reactivity
      expandedInactiveGroups.value = new Set(expandedInactiveGroups.value);
    }

    function isInactiveGroupExpanded(groupIndex) {
      return expandedInactiveGroups.value.has(groupIndex);
    }

    // Methods
    function setDetail(detail) {
      state.activeDetail = detail;
    }

    function closeDetail() {
      state.activeDetail = null;
    }

    function toggleExpandAll() {
      state.jsonExpandAll = !state.jsonExpandAll;
    }

    function toggleVeilView() {
      state.veilViewMode = state.veilViewMode === 'original' ? 'turns' : 'original';
    }

    function copyToClipboard(data) {
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        console.log('Copied to clipboard');
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    }

    function inspectVeilSnapshot() {
      if (!selectedFrame.value) return;
      state.activeDetail = {
        type: 'veil-snapshot',
        title: `VEIL State @ Frame ${selectedFrame.value.sequence}`,
        data: {
          sequence: state.frameFacetsSequence,
          facets: state.frameFacets,
          totalFacets: state.frameFacets.length
        }
      };
    }

    function inspectFrame() {
      if (!selectedFrame.value) return;
      state.activeDetail = {
        type: 'frame',
        title: `Frame ${selectedFrame.value.sequence}`,
        data: selectedFrame.value
      };
    }

    function inspectElementTree() {
      if (!state.elementTree) return;
      state.activeDetail = {
        type: 'element-tree',
        title: 'Element Tree',
        data: state.elementTree
      };
    }

    function selectComponent(component) {
      if (!component) return;
      const constraintSummary = (component.constraints || [])
        .map(c => c.type === 'priority' ? `priority:${c.priority}` : c.type)
        .join(', ') || 'no constraints';
      state.activeDetail = {
        type: 'component',
        title: `Component · ${component.name}`,
        subtitle: `${component.enabled ? 'Enabled' : 'Disabled'} · ${constraintSummary}`,
        data: component
      };
    }

    function inspectComponent(componentSnapshot) {
      if (!componentSnapshot) return;
      selectComponent(componentSnapshot);
    }

    function selectOperation(op, idx) {
      state.selectedOperationIndex = idx;
      setDetail({
        type: 'operation',
        title: `Operation · ${op.type}`,
        subtitle: operationMeta(op),
        operation: op,
        payload: op
      });
    }

    function selectEvent(event, idx) {
      state.selectedEventIndex = idx;
      setDetail({
        type: 'event',
        title: `Event · ${event.topic}`,
        subtitle: eventMeta(event),
        event,
        payload: event
      });
    }

    // Element tree expansion state
    const expandedElementsState = ref({});

    function handleTreeDetail(detail) {
      setDetail({
        type: detail.type || 'element',
        title: detail.title,
        subtitle: detail.subtitle,
        payload: detail.payload
      });
    }

    function insertActionSnippet(snippet) {
      if (!snippet) return;
      const request = selectedLLMRequest.value;
      if (!request) return;
      const requestId = request.id;
      const current = state.llmResponseDrafts[requestId] ?? '';
      const needsLeadingNewline = current && !current.endsWith('\n') ? '\n' : '';
      const snippetText = snippet.endsWith('\n') ? snippet : `${snippet}\n`;
      state.llmResponseDrafts[requestId] = `${current}${needsLeadingNewline}${snippetText}`;
    }

    function onActionSelect(event) {
      const value = event?.target?.value;
      if (!value) return;
      insertActionSnippet(value);
      event.target.value = '';
    }

    function togglePanel(panel) {
      if (!state.panelCollapsed || !(panel in state.panelCollapsed)) {
        return;
      }
      state.panelCollapsed[panel] = !state.panelCollapsed[panel];
    }

    // Resizing logic
    function startInspectorResize(event) {
      isResizingInspector.value = true;
      event.preventDefault();
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', onInspectorResize);
      window.addEventListener('mouseup', stopInspectorResize);
    }

    function onInspectorResize(event) {
      if (!isResizingInspector.value) return;
      const layout = layoutRef.value;
      if (!layout) return;
      const rect = layout.getBoundingClientRect();
      const minWidth = 260;
      const maxWidth = 600;
      const gap = 12;
      const handleWidth = 10;
      const rightEdge = rect.right;
      const newWidth = rightEdge - event.clientX - gap - handleWidth / 2;
      state.inspectorWidth = Math.min(maxWidth, Math.max(minWidth, newWidth));
    }

    function stopInspectorResize() {
      if (!isResizingInspector.value) return;
      isResizingInspector.value = false;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onInspectorResize);
      window.removeEventListener('mouseup', stopInspectorResize);
    }

    function clampFramePanelHeight() {
      const sidebar = sidebarRef.value;
      if (!sidebar) return;
      const rect = sidebar.getBoundingClientRect();
      const minHeight = 180;
      const maxHeight = Math.max(minHeight, rect.height - 180);
      state.framePanelHeight = Math.max(minHeight, Math.min(maxHeight, state.framePanelHeight));
    }

    function startSidebarResize(event) {
      isResizingSidebar.value = true;
      event.preventDefault();
      document.body.style.cursor = 'col-resize';
      sidebarResizeState = {
        startX: event.clientX,
        startWidth: state.sidebarWidth
      };
      window.addEventListener('mousemove', onSidebarResize);
      window.addEventListener('mouseup', stopSidebarResize);
    }

    function onSidebarResize(event) {
      if (!isResizingSidebar.value) return;
      const delta = event.clientX - sidebarResizeState.startX;
      const minWidth = 220;
      const maxWidth = 520;
      const newWidth = sidebarResizeState.startWidth + delta;
      state.sidebarWidth = Math.min(maxWidth, Math.max(minWidth, newWidth));
      clampFramePanelHeight();
    }

    function stopSidebarResize() {
      if (!isResizingSidebar.value) return;
      isResizingSidebar.value = false;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onSidebarResize);
      window.removeEventListener('mouseup', stopSidebarResize);
    }

    function startSidebarPanelResize(event) {
      const sidebar = sidebarRef.value;
      if (!sidebar) return;
      clampFramePanelHeight();
      isResizingSidebarPanels.value = true;
      event.preventDefault();
      document.body.style.cursor = 'row-resize';
      sidebarPanelResizeState = {
        startY: event.clientY,
        startHeight: state.framePanelHeight
      };
      window.addEventListener('mousemove', onSidebarPanelResize);
      window.addEventListener('mouseup', stopSidebarPanelResize);
    }

    function onSidebarPanelResize(event) {
      if (!isResizingSidebarPanels.value) return;
      const sidebar = sidebarRef.value;
      const rect = sidebar ? sidebar.getBoundingClientRect() : null;
      const delta = event.clientY - sidebarPanelResizeState.startY;
      const minHeight = 180;
      const rectLimit = rect ? rect.height - 180 : undefined;
      const maxHeight = rectLimit !== undefined ? Math.max(minHeight, rectLimit) : sidebarPanelResizeState.startHeight + delta;
      const newHeight = sidebarPanelResizeState.startHeight + delta;
      state.framePanelHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
    }

    function stopSidebarPanelResize() {
      if (!isResizingSidebarPanels.value) return;
      isResizingSidebarPanels.value = false;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onSidebarPanelResize);
      window.removeEventListener('mouseup', stopSidebarPanelResize);
    }

    // Frame deletion
    function showDeleteDialog() {
      state.showDeleteDialog = true;
      state.deleteCount = 1;
      state.deleteError = null;
    }
    
    function closeDeleteDialog() {
      state.showDeleteDialog = false;
      state.deleteError = null;
    }

    // Injection dialog
    const injectionPresets = {
      'agent-activation': {
        name: 'Agent Activation',
        description: 'Activate the agent with a manual trigger',
        template: () => {
          const agents = Array.from(state.veilState?.agents?.values() || []);
          const targetAgentId = agents.length === 1 ? agents[0].id : undefined;
          const targetAgent = agents.length === 1 ? agents[0].name : undefined;

          return {
            topic: 'debug:request-activation',
            sourceId: 'debug-ui',
            payload: {
              reason: 'Manual activation from Debug UI',
              priority: 'high',
              targetAgentId,
              targetAgent,
              streamId: 'console:debug-ui'
            }
          };
        }
      },
      'custom-event': {
        name: 'Custom Event',
        description: 'Inject a custom event with a specific topic',
        template: () => ({
          topic: 'custom:test-event',
          sourceId: 'debug-ui',
          payload: {
            message: 'Test event from Debug UI',
            timestamp: Date.now()
          }
        })
      },
      'speak-operation': {
        name: 'Speak Operation',
        description: 'Add a speech facet to trigger agent speech',
        template: () => ({
          topic: 'veil:operation',
          sourceId: 'debug-ui',
          payload: {
            operation: {
              type: 'addFacet',
              facet: {
                id: `speech-${Date.now()}`,
                type: 'speech',
                displayName: 'Test speech from Debug UI',
                content: 'This is a test message from the Debug UI',
                state: {
                  target: 'console',
                  streamId: 'console:debug-ui'
                },
                ephemeral: true,
                scope: 'global'
              }
            }
          }
        })
      },
      'state-facet': {
        name: 'State Facet',
        description: 'Add a custom state facet to VEIL',
        template: () => ({
          topic: 'veil:operation',
          sourceId: 'debug-ui',
          payload: {
            operation: {
              type: 'addFacet',
              facet: {
                id: `state-${Date.now()}`,
                type: 'custom-state',
                displayName: 'Custom state from Debug UI',
                state: {
                  key: 'value',
                  customData: { test: true }
                },
                ephemeral: false,
                scope: 'global'
              }
            }
          }
        })
      },
      'custom-json': {
        name: 'Custom JSON',
        description: 'Free-form JSON injection (edit the payload below)',
        template: () => ({
          topic: 'custom:topic',
          sourceId: 'debug-ui',
          payload: {}
        })
      }
    };

    function showInjectDialog() {
      state.showInjectDialog = true;
      state.injectionPreset = 'agent-activation';
      state.injectError = null;
      updateInjectionPayload();
    }

    function closeInjectDialog() {
      state.showInjectDialog = false;
      state.injectError = null;
    }

    function updateInjectionPayload() {
      const preset = injectionPresets[state.injectionPreset];
      if (preset && preset.template) {
        const payloadObj = preset.template();
        state.injectionPayload = JSON.stringify(payloadObj, null, 2);
      }
    }

    onMounted(async () => {
      await api.refresh(expandedElementsState.value);
      api.connectSocket();
      nextTick(() => {
        clampFramePanelHeight();
        window.addEventListener('resize', clampFramePanelHeight);
      });
    });

    onBeforeUnmount(() => {
      api.cleanupSocket();
      window.removeEventListener('resize', clampFramePanelHeight);
      stopInspectorResize();
      stopSidebarResize();
      stopSidebarPanelResize();
    });

    const layoutStyle = computed(() => ({
      '--inspector-width': `${state.inspectorWidth}px`,
      '--sidebar-width': `${state.sidebarWidth}px`,
      '--frame-panel-height': `${state.framePanelHeight}px`
    }));

    // Component execution detail expansion state
    const expandedComponents = ref(new Set());

    function toggleComponentDetail(componentId) {
      if (expandedComponents.value.has(componentId)) {
        expandedComponents.value.delete(componentId);
      } else {
        expandedComponents.value.add(componentId);
      }
      // Trigger reactivity
      expandedComponents.value = new Set(expandedComponents.value);
    }

    function isComponentDetailExpanded(componentId) {
      return expandedComponents.value.has(componentId);
    }

    return {
      state,
      filteredFrames,
      selectedFrame,
      selectedOperation,
      selectedEvent,
      timelineFrames,
      processedVeilFacets,
      availableActions,
      formatTime,
      formatTimestamp,
      shorten,
      truncate,
      formatChildren,
      summarizeFacet,
      summarizeOperation,
      summarizeEvent,
      operationMeta,
      eventMeta,
      stringify,
      
      // API actions
      selectFrame: api.selectFrame || (async (uuid) => {
        if (!uuid) return;
        const forceReload = state.selectedFrameId === uuid;
        await api.setSelectedFrame(uuid, { forceReload });
      }),
      selectOperation,
      selectEvent,
      selectComponent,
      inspectComponent,
      selectLLMRequest: api.selectLLMRequest,
      insertActionSnippet,
      onActionSelect,
      togglePanel,
      submitLLMResponse: api.submitLLMResponse,
      closeDetail,
      toggleExpandAll,
      toggleVeilView,
      getTurnLabel,
      copyToClipboard,
      inspectVeilSnapshot,
      inspectFrame,
      inspectElementTree,
      expandedElements: expandedElementsState,
      toggleElement: (id) => {
        expandedElementsState.value[id] = !expandedElementsState.value[id];
      },
      handleTreeDetail,
      refresh: () => api.refresh(expandedElementsState.value),
      activateAgent: api.activateAgent,
      loadOlderFrames: async () => {
        if (!state.framePagination.hasMore || state.framePagination.loading) return;
        await api.loadFrames({ append: true });
      },
      layoutRef,
      sidebarRef,
      layoutStyle,
      pendingLLMRequests,
      selectedLLMRequest,
      startInspectorResize,
      startSidebarResize,
      startSidebarPanelResize,
      
      // Frame deletion
      showDeleteDialog,
      closeDeleteDialog,
      confirmDelete: async () => {
        await api.confirmDelete();
        closeDeleteDialog();
        await api.refresh(expandedElementsState.value);
      },
      framesToDelete,
      
      // Injection dialog
      injectionPresets,
      showInjectDialog,
      closeInjectDialog,
      updateInjectionPayload,
      performInjection: async () => {
        await api.performInjection();
        closeInjectDialog();
      },
      toggleTracing: () => api.setTracingEnabled(!state.tracingEnabled),
      componentOperations,
      groupedComponents,
      expandedInactiveGroups,
      toggleInactiveGroup,
      isInactiveGroupExpanded,
      expandedComponents,
      toggleComponentDetail,
      isComponentDetailExpanded,
      // Streaming frame grouping
      groupedFrames,
      expandedStreamingGroups,
      toggleStreamingGroup,
      isStreamingGroupExpanded,
      reconstructAccumulatedContent
    };
  },
  template: `
    <div class="app-shell">
      <header class="app-header">
        <h1>Connectome Debug UI</h1>
        <div class="header-meta">
          <span
            class="status-pill"
            :class="{ offline: state.connectionStatus !== 'live' }"
          >
            {{ state.connectionStatus === 'live' ? 'Live' : 'Reconnecting' }}
          </span>
          <div class="metrics-row">
            <span class="badge">Incoming: {{ state.metrics.incomingFrames }}</span>
            <span class="badge">Outgoing: {{ state.metrics.outgoingFrames }}</span>
            <span class="badge" v-if="state.metrics.totalEvents">Events: {{ state.metrics.totalEvents }}</span>
          </div>
        </div>
        <div class="controls">
          <button 
            class="button" 
            :class="{ 'button--active': state.tracingEnabled }"
            @click="toggleTracing"
            title="Toggle execution tracing"
          >
            {{ state.tracingEnabled ? 'Trace ON' : 'Trace OFF' }}
          </button>
          <button class="button" @click="refresh">Refresh</button>
          <button class="button button--primary" @click="activateAgent">Activate Agent</button>
          <button class="button button--primary" @click="showInjectDialog">Inject Event</button>
          <button class="button button--danger" @click="showDeleteDialog" :disabled="!state.frames.length">Delete Frames</button>
        </div>
      </header>
      <div class="error-banner" v-if="state.error">
        {{ state.error }}
      </div>
      <div class="layout" :style="layoutStyle" ref="layoutRef">
        <aside class="sidebar" ref="sidebarRef">
          <section class="panel frame-panel">
            <div class="panel-header">
              <h2>Frames</h2>
              <span class="badge" v-if="filteredFrames.length">{{ filteredFrames.length }}</span>
            </div>
            <input
              class="search-input"
              v-model="state.filters.search"
              placeholder="Search frames by uuid, stream, agent..."
            />
            <div class="frame-list">
              <template v-for="(group, groupIdx) in groupedFrames" :key="groupIdx">
                <!-- Single frame (non-streaming or single streaming) -->
                <div
                  v-if="group.type === 'single'"
                  :class="['frame-item', state.selectedFrameId === group.frame.uuid ? 'active' : '', group.frame.kind]"
                  @click="selectFrame(group.frame.uuid)"
                >
                  <span class="frame-seq">#{{ group.frame.sequence }}</span>
                  <span class="frame-kind" :class="group.frame.kind">{{ group.frame.kind }}</span>
                  <span class="frame-time">{{ formatTimestamp(group.frame.timestamp).split(' ')[1] }}</span>
                  <span class="frame-stats">{{ group.frame.deltas?.length || 0 }}op {{ group.frame.events?.length || 0 }}ev</span>
                  <span v-if="group.frame.durationMs" class="frame-duration">{{ group.frame.durationMs.toFixed(0) }}ms</span>
                </div>

                <!-- Streaming frame group (collapsible) -->
                <div v-else-if="group.type === 'streaming-group'" class="streaming-group">
                  <div
                    :class="['frame-item', 'streaming-group-header', group.kind]"
                    @click="toggleStreamingGroup(groupIdx)"
                  >
                    <span class="expand-icon">{{ isStreamingGroupExpanded(groupIdx) ? '▼' : '▶' }}</span>
                    <span class="frame-seq">#{{ group.firstSequence }}-{{ group.lastSequence }}</span>
                    <span class="frame-kind" :class="group.kind">{{ group.kind }}</span>
                    <span class="streaming-count">{{ group.count }} streaming frames</span>
                  </div>
                  <!-- Expanded: show reconstructed content preview -->
                  <div v-if="isStreamingGroupExpanded(groupIdx)" class="streaming-group-content">
                    <div class="streaming-preview">
                      <div class="streaming-preview-label">Reconstructed content:</div>
                      <pre class="streaming-preview-text">{{ truncate(group.reconstructedContent, 500) }}</pre>
                    </div>
                    <!-- Individual frames -->
                    <div
                      v-for="frame in group.frames"
                      :key="frame.uuid"
                      :class="['frame-item', 'frame-item-nested', state.selectedFrameId === frame.uuid ? 'active' : '', frame.kind]"
                      @click.stop="selectFrame(frame.uuid)"
                    >
                      <span class="frame-seq">#{{ frame.sequence }}</span>
                      <span class="frame-kind" :class="frame.kind">{{ frame.kind }}</span>
                      <span class="frame-time">{{ formatTimestamp(frame.timestamp).split(' ')[1] }}</span>
                      <span class="frame-stats">seq {{ frame.streamSequence || '?' }}</span>
                    </div>
                  </div>
                </div>
              </template>
              <div v-if="!groupedFrames.length" class="text-muted">No frames yet.</div>
              <div
                v-else-if="state.framePagination.hasMore"
                class="frame-load-more"
              >
                <button
                  class="button"
                  :disabled="state.framePagination.loading"
                  @click="loadOlderFrames"
                >
                  {{ state.framePagination.loading ? 'Loading…' : 'Load Older Frames' }}
                </button>
              </div>
              <div
                v-else
                class="frame-load-more text-muted"
              >
                Start of retained history
              </div>
            </div>
          </section>
          <div class="sidebar-splitter" @mousedown="startSidebarPanelResize"></div>
          <section class="panel veil-panel">
            <div class="panel-header">
              <h2>VEIL State</h2>
              <div class="header-badges">
                <span class="badge" v-if="state.frameFacetsSequence != null" title="Historical state as of frame sequence">
                  📸 @ seq {{ state.frameFacetsSequence }}
                </span>
                <span class="badge" v-else-if="state.frameFacets.length">{{ state.frameFacets.length }} facets</span>
                <button class="button button--small" @click="toggleVeilView" v-if="state.frameFacets.length" :title="state.veilViewMode === 'original' ? 'Switch to Turn View' : 'Switch to Original Order'">
                  {{ state.veilViewMode === 'original' ? '🔄' : '⏰' }}
                </button>
                <button class="button button--small" @click="inspectVeilSnapshot" v-if="state.frameFacets.length" title="Inspect full snapshot">
                  🔍
                </button>
              </div>
            </div>
            <div class="veil-tree" v-if="state.frameFacets.length">
              <div style="padding: 8px; background: #1a1a2e; border-bottom: 1px solid #0f3460; font-size: 0.85em; color: #888;">
                💡 Showing VEIL state as it existed at frame {{ state.frameFacetsSequence }}
              </div>
              <template v-if="state.veilViewMode === 'original'">
                <facet-tree
                  :facets="state.frameFacets"
                  :expanded-depth="1"
                  @show-detail="handleTreeDetail"
                />
              </template>
              <template v-else>
                <div v-for="turn in processedVeilFacets.turns" :key="turn.type" class="veil-turn" :data-turn-type="turn.type">
                  <div class="turn-header">{{ turn.label }}</div>
                  <facet-tree
                    :facets="turn.facets"
                    :expanded-depth="1"
                    @show-detail="handleTreeDetail"
                  />
                </div>
              </template>
            </div>
            <div v-else class="text-muted">No active facets for this frame.</div>
          </section>
        </aside>
        <div class="splitter splitter-left" @mousedown="startSidebarResize"></div>
        <section class="content-area">
          <section
            class="panel llm-panel"
            v-if="state.debugLLMEnabled"
            :class="{ 'panel-collapsed': state.panelCollapsed.llm }"
          >
            <div class="panel-header">
              <div class="panel-header-title">
                <button
                  class="panel-toggle"
                  type="button"
                  :aria-expanded="!state.panelCollapsed.llm"
                  :title="state.panelCollapsed.llm ? 'Expand panel' : 'Collapse panel'"
                  @click="togglePanel('llm')"
                >
                  {{ state.panelCollapsed.llm ? '▸' : '▾' }}
                </button>
                <h2>Manual LLM Completions</h2>
              </div>
              <div class="panel-header-actions" v-if="pendingLLMRequests.length">
                <span class="badge">{{ pendingLLMRequests.length }} pending</span>
              </div>
            </div>
            <div class="llm-body" v-show="!state.panelCollapsed.llm">
              <div class="llm-request-list">
                <div
                  v-for="request in state.debugLLMRequests"
                  :key="request.id"
                  :class="['llm-request-item', { active: state.selectedLLMRequestId === request.id, resolved: request.status !== 'pending' }]"
                  @click="selectLLMRequest(request.id)"
                >
                  <div class="llm-request-header">
                    <span class="llm-request-id">{{ shorten(request.id, 10) }}</span>
                    <span class="llm-request-provider">{{ request.providerId || 'debug' }}</span>
                    <span class="llm-request-status" :class="request.status">{{ request.status }}</span>
                  </div>
                  <div class="llm-request-summary">
                    {{ truncate(request.messages?.[request.messages.length - 1]?.content || '—', 80) }}
                  </div>
                  <div class="llm-request-timestamp">{{ formatTimestamp(request.createdAt) }}</div>
                </div>
                <div v-if="!state.debugLLMRequests.length" class="llm-empty text-muted">
                  Awaiting LLM requests…
                </div>
              </div>
              <div class="llm-request-detail" v-if="selectedLLMRequest">
                <div class="llm-detail-header">
                  <div class="detail-meta">
                    <span>Request {{ shorten(selectedLLMRequest.id, 12) }}</span>
                    <span v-if="selectedLLMRequest.metadata?.description">· {{ selectedLLMRequest.metadata.description }}</span>
                    <span>· {{ formatTimestamp(selectedLLMRequest.createdAt) }}</span>
                    <span v-if="selectedLLMRequest.completedAt">· Completed {{ formatTimestamp(selectedLLMRequest.completedAt) }}</span>
                  </div>
                  <div class="detail-status" :class="selectedLLMRequest.status">{{ selectedLLMRequest.status }}</div>
                </div>
                <div class="llm-context">
                  <div
                    v-for="(msg, idx) in selectedLLMRequest.messages"
                    :key="idx"
                    class="message-card"
                  >
                    <div class="role">{{ msg.role }}</div>
                    <pre>{{ msg.content }}</pre>
                  </div>
                </div>
                <div v-if="selectedLLMRequest.status === 'pending'" class="llm-response-editor">
                  <div class="llm-action-bar" v-if="availableActions.length">
                    <label
                      class="llm-action-label"
                      :for="'llm-actions-' + selectedLLMRequest.id"
                    >
                      Registered Actions
                    </label>
                    <select
                      class="llm-action-select"
                      :id="'llm-actions-' + selectedLLMRequest.id"
                      @change="onActionSelect"
                    >
                      <option value="">Insert action…</option>
                      <option
                        v-for="action in availableActions"
                        :key="action.text"
                        :value="action.text"
                        :title="action.source ? 'Facet: ' + action.source : 'Insert action snippet'"
                      >
                        {{ action.text }}
                      </option>
                    </select>
                  </div>
                  <textarea
                    class="llm-textarea"
                    v-model="state.llmResponseDrafts[selectedLLMRequest.id]"
                    placeholder="Type the assistant response…"
                    rows="6"
                  ></textarea>
                  <div class="llm-response-controls">
                    <input
                      class="input"
                      type="text"
                      placeholder="Model override (optional)"
                      v-model="state.llmModelOverrides[selectedLLMRequest.id]"
                    />
                    <button
                      class="button"
                      :disabled="state.llmSubmitting"
                      @click="submitLLMResponse(selectedLLMRequest.id)"
                    >
                      {{ state.llmSubmitting ? 'Submitting…' : 'Send Response' }}
                    </button>
                  </div>
                  <div class="error-message" v-if="state.llmSubmitError">{{ state.llmSubmitError }}</div>
                </div>
                <div v-else class="llm-response-view">
                  <h3>Submitted Response</h3>
                  <pre>{{ selectedLLMRequest.response?.content || '—' }}</pre>
                  <div class="llm-response-meta" v-if="selectedLLMRequest.response?.modelId || selectedLLMRequest.response?.tokensUsed">
                    <span v-if="selectedLLMRequest.response?.modelId">Model: {{ selectedLLMRequest.response.modelId }}</span>
                    <span v-if="selectedLLMRequest.response?.tokensUsed">Tokens: {{ selectedLLMRequest.response.tokensUsed }}</span>
                  </div>
                </div>
              </div>
              <div class="llm-request-detail llm-request-placeholder" v-else>
                <div class="text-muted">Select a request to inspect the prompt and provide a response.</div>
              </div>
            </div>
          </section>
          <section
            class="panel timeline-panel"
            v-if="timelineFrames.length"
            :class="{ 'panel-collapsed': state.panelCollapsed.timeline }"
          >
            <div class="panel-header">
              <div class="panel-header-title">
                <button
                  class="panel-toggle"
                  type="button"
                  :aria-expanded="!state.panelCollapsed.timeline"
                  :title="state.panelCollapsed.timeline ? 'Expand panel' : 'Collapse panel'"
                  @click="togglePanel('timeline')"
                >
                  {{ state.panelCollapsed.timeline ? '▸' : '▾' }}
                </button>
                <h2>Frame Timeline</h2>
              </div>
              <div class="panel-header-actions">
                <span class="badge">Newest {{ timelineFrames.length }}</span>
              </div>
            </div>
            <div class="timeline-body" v-show="!state.panelCollapsed.timeline">
              <div
                v-for="frame in timelineFrames"
                :key="frame.uuid"
                :class="['timeline-node', { active: state.selectedFrameId === frame.uuid, outgoing: frame.kind === 'outgoing' }]"
                @click="selectFrame(frame.uuid)"
              >
                <span class="timeline-seq">#{{ frame.sequence }}</span>
                <span class="timeline-kind">{{ frame.kind }}</span>
              </div>
            </div>
          </section>
          <section
            class="panel frame-detail"
            :class="{ 'panel-collapsed': state.panelCollapsed.frameDetail }"
          >
            <div class="panel-header frame-header">
              <div class="panel-header-title">
                <button
                  class="panel-toggle"
                  type="button"
                  :aria-expanded="!state.panelCollapsed.frameDetail"
                  :title="state.panelCollapsed.frameDetail ? 'Expand panel' : 'Collapse panel'"
                  @click="togglePanel('frameDetail')"
                >
                  {{ state.panelCollapsed.frameDetail ? '▸' : '▾' }}
                </button>
                <h2 v-if="selectedFrame">Frame {{ selectedFrame.sequence }}</h2>
                <h2 v-else>Frame Details</h2>
              </div>
              <div class="panel-header-actions frame-header-actions">
                <button
                  class="button button--small"
                  v-if="selectedFrame"
                  @click="inspectFrame"
                  title="Inspect full frame"
                >
                  🔍
                </button>
                <div class="frame-meta" v-if="selectedFrame">
                  <span class="meta-pill">UUID: {{ shorten(selectedFrame.uuid, 18) }}</span>
                  <span class="meta-pill">{{ formatTimestamp(selectedFrame.timestamp) }}</span>
                  <span class="meta-pill kind" :class="selectedFrame.kind">{{ selectedFrame.kind }}</span>
                  <span class="meta-pill" v-if="state.frameFacetsSequence != null" title="VEIL state as of this frame sequence">
                    📸 VEIL @ seq {{ state.frameFacetsSequence }}
                  </span>
                  <span
                    class="meta-pill"
                    v-if="selectedFrame.activeStream"
                  >
                    Stream: {{ shorten(selectedFrame.activeStream.streamId, 18) }}
                  </span>
                  <span
                    class="meta-pill"
                    v-if="selectedFrame.agent"
                  >
                    Agent: {{ shorten(selectedFrame.agent.name || selectedFrame.agent.id, 18) }}
                  </span>
                </div>
              </div>
            </div>
            <div class="frame-detail-body" v-show="!state.panelCollapsed.frameDetail">
              <template v-if="selectedFrame">
                <div class="section">
                  <h3>Trigger Event</h3>
                  <div class="log-viewer events">
                    <div v-if="!selectedFrame.events?.length" class="text-muted">No trigger event.</div>
                    <div
                      v-for="(event, idx) in selectedFrame.events"
                      :key="event.id || idx"
                      class="log-entry"
                      @click="selectEvent(event, idx)"
                    >
                      <span class="log-timestamp">{{ formatTimestamp(event.timestamp).split(' ')[1] }}</span>
                      <span class="log-type">{{ event.topic }}</span>
                      <span class="log-content">
                        <span v-if="event.phase && event.phase !== 'none'" class="log-phase">[{{ event.phase }}]</span>
                        <span v-if="event.target" class="log-target">{{ event.target.elementPath?.join('/') || event.target.elementId }}</span>
                        <span v-if="event.payload" class="log-payload">{{ truncate(stringify(event.payload), 80) }}</span>
                      </span>
                      <span class="log-meta" v-if="eventMeta(event)">{{ eventMeta(event) }}</span>
                    </div>
                  </div>
                </div>
                <div class="section" v-if="selectedFrame.renderedContext">
                  <h3>Rendered Context</h3>
                  <div class="section-body message-list">
                    <div
                      class="message-card"
                      v-for="(msg, idx) in selectedFrame.renderedContext.messages"
                      :key="idx"
                    >
                      <div class="role">{{ msg.role }}</div>
                      <pre>{{ msg.content }}</pre>
                    </div>
                    <div class="message-card" v-if="selectedFrame.renderedContext.metadata">
                      <div class="role">metadata</div>
                      <div style="padding: 8px;">
                        <json-viewer :data="selectedFrame.renderedContext.metadata" :expandAll="state.jsonExpandAll" />
                      </div>
                    </div>
                  </div>
                </div>
                <div class="section" v-if="selectedFrame.renderedContext">
                  <h3>LLM Request JSON</h3>
                  <div class="section-body">
                    <json-viewer :data="selectedFrame.renderedContext" :expandAll="state.jsonExpandAll" />
                  </div>
                </div>
                <div class="section">
                  <h3>Component Executions & Operations</h3>
                  <div class="log-viewer operations">
                    <div v-if="groupedComponents.length === 0" class="text-muted">No operations.</div>
                    <template v-for="(group, groupIdx) in groupedComponents" :key="groupIdx">
                      <!-- Active component -->
                      <template v-if="group.type === 'active'">
                        <div class="component-ops-group has-activity">
                        <div class="component-ops-header" style="display: flex; align-items: center; cursor: pointer;">
                          <span class="component-name" @click="toggleComponentDetail(group.component.componentId)" style="flex: 1;">
                            <span class="expand-icon">{{ isComponentDetailExpanded(group.component.componentId) ? '▼' : '▶' }}</span>
                            {{ group.component.componentName }}
                          </span>
                          <span class="component-stats">
                            <span v-if="group.component.deltaCount > 0" class="stat">{{ group.component.deltaCount }} ops</span>
                            <span v-if="group.component.durationMs !== undefined" class="stat">{{ group.component.durationMs.toFixed(1) }}ms</span>
                            <span v-if="group.component.emittedEvents > 0" class="stat">{{ group.component.emittedEvents }} events</span>
                            <span v-if="group.component.error" class="stat error">ERROR</span>
                            <button
                              v-if="group.component.componentSnapshot"
                              @click.stop="inspectComponent(group.component.componentSnapshot)"
                              class="component-inspect-btn"
                              title="Inspect component details"
                            >🔍</button>
                          </span>
                        </div>

                        <!-- Detailed execution info (expandable) -->
                        <div v-if="isComponentDetailExpanded(group.component.componentId)" class="component-execution-detail">
                          <!-- Input Context -->
                          <div v-if="group.component.context" class="execution-section">
                            <h4>Input Context</h4>
                            <div class="context-item" v-if="group.component.context.inputEvent">
                              <strong>Event:</strong> {{ group.component.context.inputEvent.topic }}
                              <pre v-if="group.component.context.inputEvent.payload">{{ JSON.stringify(group.component.context.inputEvent.payload, null, 2) }}</pre>
                            </div>
                            <div class="context-item" v-if="group.component.context.stateSnapshot">
                              <strong>State:</strong> {{ group.component.context.stateSnapshot.facetCount }} facets at sequence {{ group.component.context.stateSnapshot.sequence }}
                            </div>
                            <div class="context-item" v-if="group.component.context.eventBufferSnapshot">
                              <strong>Event Buffer:</strong> {{ group.component.context.eventBufferSnapshot.length }} queued events
                              <div v-if="group.component.context.eventBufferSnapshot.length > 0" style="margin-top: 4px;">
                                <div v-for="(bufEvt, bufIdx) in group.component.context.eventBufferSnapshot" :key="bufIdx" class="buffer-event-item">
                                  <span style="font-size: 0.68rem; color: var(--text-muted);">{{ bufIdx + 1 }}.</span>
                                  <strong>{{ bufEvt.topic }}</strong>
                                  <pre v-if="bufEvt.payload">{{ JSON.stringify(bufEvt.payload, null, 2) }}</pre>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- Emitted Events -->
                          <div v-if="group.component.emittedEventDetails && group.component.emittedEventDetails.length > 0" class="execution-section">
                            <h4>Emitted Events ({{ group.component.emittedEventDetails.length }})</h4>
                            <div v-for="(evt, evtIdx) in group.component.emittedEventDetails" :key="evtIdx" class="emitted-event-item">
                              <strong>{{ evt.topic }}</strong>
                              <pre v-if="evt.payload">{{ JSON.stringify(evt.payload, null, 2) }}</pre>
                            </div>
                          </div>

                          <!-- Operations Summary -->
                          <div v-if="group.component.deltaCount > 0" class="execution-section">
                            <h4>Operations ({{ group.component.deltaCount }})</h4>
                            <div class="text-muted">See below for detailed operations</div>
                          </div>

                          <!-- Error Details -->
                          <div v-if="group.component.error" class="execution-section error-section">
                            <h4>Error</h4>
                            <pre>{{ group.component.error }}</pre>
                          </div>
                        </div>

                        <template v-for="(op, idx) in group.component.operations" :key="idx">
                          <div v-if="op.type === 'addFacet' && op.facet" class="log-entry facet-entry">
                            <div class="facet-header" @click="selectOperation(op, idx)">
                              <span class="log-type">{{ op.type }}</span>
                              <span class="log-meta" v-if="operationMeta(op)">{{ operationMeta(op) }}</span>
                            </div>
                            <inline-facet-tree
                              :facet="op.facet"
                              :depth="0"
                              @show-detail="handleTreeDetail"
                            />
                          </div>
                          <div v-else class="log-entry" @click="selectOperation(op, idx)">
                            <span class="log-type">{{ op.type }}</span>
                            <span class="log-content">
                              <template v-if="op.type === 'speak'">
                                <span class="log-speak">{{ truncate(op.content, 120) }}</span>
                                <span class="log-meta" v-if="op.target"> → {{ op.target }}</span>
                              </template>
                              <template v-else-if="op.type === 'changeState'">
                                <span v-if="op.updates?.content" class="log-state">content: {{ truncate(op.updates.content, 80) }}</span>
                                <span v-else-if="op.updates?.attributes" class="log-state">
                                  {{ Object.keys(op.updates.attributes).join(', ') }}
                                </span>
                              </template>
                              <template v-else-if="op.type === 'action'">
                                <span class="log-action">{{ (op.path || []).join('.') }}</span>
                              </template>
                              <template v-else>
                                <span class="log-raw">{{ truncate(stringify(op), 100) }}</span>
                              </template>
                            </span>
                            <span class="log-meta" v-if="operationMeta(op)">{{ operationMeta(op) }}</span>
                          </div>
                        </template>
                      </div>
                      </template>

                      <!-- Single inactive component (grayed out, same structure as active) -->
                      <template v-else-if="group.type === 'single-inactive'">
                        <div class="component-ops-group inactive-component">
                        <div class="component-ops-header" style="display: flex; align-items: center; cursor: pointer;">
                          <span class="component-name" @click="toggleComponentDetail(group.component.componentId)" style="flex: 1;">
                            <span class="expand-icon">{{ isComponentDetailExpanded(group.component.componentId) ? '▼' : '▶' }}</span>
                            {{ group.component.componentName }}
                          </span>
                          <span class="component-stats">
                            <span class="stat">no activity</span>
                            <span v-if="group.component.durationMs !== undefined" class="stat">{{ group.component.durationMs.toFixed(1) }}ms</span>
                            <button
                              v-if="group.component.componentSnapshot"
                              @click.stop="inspectComponent(group.component.componentSnapshot)"
                              class="component-inspect-btn"
                              title="Inspect component details"
                            >🔍</button>
                          </span>
                        </div>

                        <!-- Detailed execution info (expandable) -->
                        <div v-if="isComponentDetailExpanded(group.component.componentId)" class="component-execution-detail">
                          <!-- Input Context -->
                          <div v-if="group.component.context" class="execution-section">
                            <h4>Input Context</h4>
                            <div class="context-item" v-if="group.component.context.inputEvent">
                              <strong>Event:</strong> {{ group.component.context.inputEvent.topic }}
                              <pre v-if="group.component.context.inputEvent.payload">{{ JSON.stringify(group.component.context.inputEvent.payload, null, 2) }}</pre>
                            </div>
                            <div class="context-item" v-if="group.component.context.stateSnapshot">
                              <strong>State:</strong> {{ group.component.context.stateSnapshot.facetCount }} facets at sequence {{ group.component.context.stateSnapshot.sequence }}
                            </div>
                            <div class="context-item" v-if="group.component.context.eventBufferSnapshot">
                              <strong>Event Buffer:</strong> {{ group.component.context.eventBufferSnapshot.length }} queued events
                              <div v-if="group.component.context.eventBufferSnapshot.length > 0" style="margin-top: 4px;">
                                <div v-for="(bufEvt, bufIdx) in group.component.context.eventBufferSnapshot" :key="bufIdx" class="buffer-event-item">
                                  <span style="font-size: 0.68rem; color: var(--text-muted);">{{ bufIdx + 1 }}.</span>
                                  <strong>{{ bufEvt.topic }}</strong>
                                  <pre v-if="bufEvt.payload">{{ JSON.stringify(bufEvt.payload, null, 2) }}</pre>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- No operations message -->
                          <div class="execution-section">
                            <div class="text-muted" style="padding: 4px 0;">This component executed but produced no operations or events.</div>
                          </div>
                        </div>
                      </div>
                      </template>

                      <!-- Multiple inactive components (collapsible group) -->
                      <template v-else-if="group.type === 'inactive-group'">
                        <div class="component-ops-group inactive-group">
                          <div class="component-ops-header inactive-group-header" @click="toggleInactiveGroup(groupIdx)" style="display: flex; align-items: center; cursor: pointer;">
                            <span class="component-name" style="flex: 1;">
                              <span class="expand-icon">{{ isInactiveGroupExpanded(groupIdx) ? '▼' : '▶' }}</span>
                              {{ group.count }} components with no ops/events
                            </span>
                          </div>
                          <template v-if="isInactiveGroupExpanded(groupIdx)">
                            <!-- Show each inactive component with full structure -->
                            <div v-for="(comp, compIdx) in group.components" :key="compIdx" class="inactive-component-in-group">
                              <div class="component-ops-header" style="display: flex; align-items: center; cursor: pointer;">
                                <span class="component-name" @click="toggleComponentDetail(comp.componentId)" style="flex: 1;">
                                  <span class="expand-icon">{{ isComponentDetailExpanded(comp.componentId) ? '▼' : '▶' }}</span>
                                  {{ comp.componentName }}
                                </span>
                                <span class="component-stats">
                                  <span class="stat">no activity</span>
                                  <span v-if="comp.durationMs !== undefined" class="stat">{{ comp.durationMs.toFixed(1) }}ms</span>
                                  <button
                                    v-if="comp.componentSnapshot"
                                    @click.stop="inspectComponent(comp.componentSnapshot)"
                                    class="component-inspect-btn"
                                    title="Inspect component details"
                                  >🔍</button>
                                </span>
                              </div>

                              <!-- Detailed execution info (expandable) -->
                              <div v-if="isComponentDetailExpanded(comp.componentId)" class="component-execution-detail">
                                <!-- Input Context -->
                                <div v-if="comp.context" class="execution-section">
                                  <h4>Input Context</h4>
                                  <div class="context-item" v-if="comp.context.inputEvent">
                                    <strong>Event:</strong> {{ comp.context.inputEvent.topic }}
                                    <pre v-if="comp.context.inputEvent.payload">{{ JSON.stringify(comp.context.inputEvent.payload, null, 2) }}</pre>
                                  </div>
                                  <div class="context-item" v-if="comp.context.stateSnapshot">
                                    <strong>State:</strong> {{ comp.context.stateSnapshot.facetCount }} facets at sequence {{ comp.context.stateSnapshot.sequence }}
                                  </div>
                                  <div class="context-item" v-if="comp.context.eventBufferSnapshot">
                                    <strong>Event Buffer:</strong> {{ comp.context.eventBufferSnapshot.length }} queued events
                                    <div v-if="comp.context.eventBufferSnapshot.length > 0" style="margin-top: 4px;">
                                      <div v-for="(bufEvt, bufIdx) in comp.context.eventBufferSnapshot" :key="bufIdx" class="buffer-event-item">
                                        <span style="font-size: 0.68rem; color: var(--text-muted);">{{ bufIdx + 1 }}.</span>
                                        <strong>{{ bufEvt.topic }}</strong>
                                        <pre v-if="bufEvt.payload">{{ JSON.stringify(bufEvt.payload, null, 2) }}</pre>
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <!-- No operations message -->
                                <div class="execution-section">
                                  <div class="text-muted" style="padding: 4px 0;">This component executed but produced no operations or events.</div>
                                </div>
                              </div>
                            </div>
                          </template>
                        </div>
                      </template>
                    </template>
                  </div>
                </div>
              </template>
              <div v-else class="section-body text-muted">
                Select a frame from the left to inspect operations and rendered context.
              </div>
            </div>
          </section>
        </section>
        <div class="splitter splitter-right" @mousedown="startInspectorResize"></div>
        <aside class="inspector" :class="{ 'inspector-visible': state.activeDetail }">
          <section
            class="panel inspector-panel"
            :class="{ 'panel-collapsed': state.panelCollapsed.inspector }"
          >
            <div class="panel-header inspector-header">
              <div class="panel-header-title">
                <button
                  class="panel-toggle"
                  type="button"
                  :aria-expanded="!state.panelCollapsed.inspector"
                  :title="state.panelCollapsed.inspector ? 'Expand panel' : 'Collapse panel'"
                  @click="togglePanel('inspector')"
                >
                  {{ state.panelCollapsed.inspector ? '▸' : '▾' }}
                </button>
                <h2>Inspector</h2>
              </div>
              <div class="panel-header-actions header-actions" v-if="state.activeDetail">
                <button class="button button--small" @click="toggleExpandAll" :title="state.jsonExpandAll ? 'Collapse All' : 'Expand All'">
                  {{ state.jsonExpandAll ? '📁' : '📂' }} {{ state.jsonExpandAll ? 'Collapse' : 'Expand' }}
                </button>
                <button class="button button--small" @click="copyToClipboard(state.activeDetail.payload ?? state.activeDetail)" title="Copy to clipboard">
                  📋 Copy
                </button>
                <button class="button" @click="closeDetail">Close</button>
              </div>
            </div>
            <div class="inspector-content" v-show="!state.panelCollapsed.inspector">
              <div v-if="state.activeDetail" class="inspector-body">
                <div class="inspector-title">{{ state.activeDetail.title }}</div>
                <div v-if="state.activeDetail.subtitle" class="inspector-subtitle">{{ state.activeDetail.subtitle }}</div>
                <div class="inspector-json">
                  <json-viewer :data="state.activeDetail.payload ?? state.activeDetail" :expandAll="state.jsonExpandAll" />
                </div>
              </div>
              <div v-else class="inspector-placeholder">
                Select an operation, event, or element to inspect.
              </div>
            </div>
          </section>
        </aside>
      </div>
      
      <!-- Frame Deletion Dialog -->
      <div class="modal-overlay" v-if="state.showDeleteDialog" @click="closeDeleteDialog">
        <div class="modal" @click.stop>
          <div class="modal-header">
            <h2>Delete Recent Frames</h2>
            <button class="close-button" @click="closeDeleteDialog">&times;</button>
          </div>
          <div class="modal-body">
            <p class="warning">
              <strong>⚠️ Warning:</strong> This will delete recent frames and revert the agent state. 
              Fork-invariant components will be preserved, but stateful components will be reinitialized.
            </p>
            
            <div class="form-group">
              <label>Number of frames to delete:</label>
              <input 
                type="number" 
                v-model.number="state.deleteCount" 
                min="1" 
                :max="state.frames.length"
                class="input"
              />
              <small>Total frames available: {{ state.frames.length }}</small>
            </div>
            
            <div v-if="state.deleteCount > 0 && state.deleteCount <= state.frames.length" class="frame-preview">
              <h3>Frames to be deleted:</h3>
              <ul class="frame-list">
                <li v-for="frame in framesToDelete" :key="frame.uuid">
                  Seq {{ frame.sequence }} - {{ frame.kind }} 
                  <span class="timestamp">{{ formatTime(frame.timestamp) }}</span>
                </li>
              </ul>
            </div>
            
            <div v-if="state.deleteError" class="error-message">
              {{ state.deleteError }}
            </div>
          </div>
          <div class="modal-footer">
            <button class="button" @click="closeDeleteDialog">Cancel</button>
            <button 
              class="button button--danger" 
              @click="confirmDelete"
              :disabled="!state.deleteCount || state.deleteCount > state.frames.length || state.deleting"
            >
              {{ state.deleting ? 'Deleting...' : 'Delete Frames' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Injection Dialog -->
      <div class="modal-overlay" v-if="state.showInjectDialog" @click="closeInjectDialog">
        <div class="modal" @click.stop style="max-width: 700px;">
          <div class="modal-header">
            <h2>Inject Event / Facet</h2>
            <button class="close-button" @click="closeInjectDialog">&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>Preset Template:</label>
              <select
                v-model="state.injectionPreset"
                @change="updateInjectionPayload"
                class="input"
              >
                <option
                  v-for="(preset, key) in injectionPresets"
                  :key="key"
                  :value="key"
                >
                  {{ preset.name }} - {{ preset.description }}
                </option>
              </select>
              <small>Select a preset template or choose "Custom JSON" to write your own</small>
            </div>

            <div class="form-group">
              <label>JSON Payload:</label>
              <textarea
                v-model="state.injectionPayload"
                class="input"
                rows="16"
                style="font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.85rem;"
                spellcheck="false"
              ></textarea>
              <small>Edit the JSON payload above. Must include a "topic" field.</small>
            </div>

            <div v-if="state.injectError" class="error-message">
              {{ state.injectError }}
            </div>
          </div>
          <div class="modal-footer">
            <button class="button" @click="closeInjectDialog">Cancel</button>
            <button
              class="button button--primary"
              @click="performInjection"
              :disabled="state.injecting || !state.injectionPayload"
            >
              {{ state.injecting ? 'Injecting...' : 'Inject Event' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};
