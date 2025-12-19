import { formatTimestamp } from '../utils.js';

export default {
  name: 'FrameList',
  props: {
    frames: { type: Array, required: true },
    selectedFrameId: { type: String, default: null },
    loading: { type: Boolean, default: false },
    hasMore: { type: Boolean, default: false }
  },
  emits: ['select', 'load-more'],
  setup() {
    return {
      formatTimestamp
    };
  },
  template: `
    <div class="frame-list">
      <div
        v-for="frame in frames"
        :key="frame.uuid"
        :class="['frame-item', selectedFrameId === frame.uuid ? 'active' : '']"
        @click="$emit('select', frame.uuid)"
      >
        <span class="frame-seq">#{{ frame.sequence }}</span>
        <span class="frame-kind" :class="frame.kind">{{ frame.kind }}</span>
        <span class="frame-time">{{ formatTimestamp(frame.timestamp).split(' ')[1] }}</span>
        <span class="frame-stats">{{ frame.deltas?.length || 0 }}op {{ frame.events?.length || 0 }}ev</span>
        <span v-if="frame.durationMs" class="frame-duration">{{ frame.durationMs.toFixed(0) }}ms</span>
      </div>
      <div v-if="!frames.length" class="text-muted">No frames yet.</div>
      <div
        v-else-if="hasMore"
        class="frame-load-more"
      >
        <button
          class="button"
          :disabled="loading"
          @click="$emit('load-more')"
        >
          {{ loading ? 'Loading…' : 'Load Older Frames' }}
        </button>
      </div>
      <div
        v-else
        class="frame-load-more text-muted"
      >
        Start of retained history
      </div>
    </div>
  `
};
