import { reactive } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';

export const state = reactive({
  frames: [],
  metrics: {
    incomingFrames: 0,
    outgoingFrames: 0,
    totalEvents: 0,
    averageDurationMs: 0
  },
  frameFacets: [],
  frameFacetsSequence: null,
  elementTree: null,
  components: [],
  selectedFrameId: null,
  filters: {
    search: ''
  },
  connectionStatus: 'connecting',
  debugLLMEnabled: false,
  tracingEnabled: false,
  lastUpdated: null,
  loadingFrame: false,
  framePagination: {
    limit: 150,
    nextOffset: 0,
    hasMore: true,
    loading: false
  },
  error: null,
  selectedOperationIndex: null,
  selectedEventIndex: null,
  activeDetail: null,
  inspectorWidth: 360,
  sidebarWidth: 320,
  framePanelHeight: 320,
  jsonExpandAll: false,
  veilViewMode: 'turns', // 'original' or 'turns'
  // Frame deletion dialog
  showDeleteDialog: false,
  deleteCount: 1,
  deleting: false,
  deleteError: null,
  // Injection dialog
  showInjectDialog: false,
  injectionPreset: 'agent-activation',
  injectionPayload: '',
  injecting: false,
  injectError: null,
  // Manual LLM provider
  debugLLMRequests: [],
  selectedLLMRequestId: null,
  llmResponseDrafts: {},
  llmModelOverrides: {},
  llmSubmitting: false,
  llmSubmitError: null,
  panelCollapsed: {
    llm: false,
    timeline: false,
    frameDetail: false,
    components: false,
    inspector: false
  }
});
