import { ref, computed, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';

export const JsonViewer = {
  name: 'JsonViewer',
  props: {
    data: { required: true },
    depth: { type: Number, default: 0 },
    expandAll: { type: Boolean, default: false }
  },
  setup(props) {
    const isExpanded = ref(props.expandAll || props.depth < 2);
    
    // Watch for expandAll changes
    watch(() => props.expandAll, (newVal) => {
      if (newVal) {
        isExpanded.value = true;
      }
    });
    
    const dataType = computed(() => {
      const d = props.data;
      if (d === null) return 'null';
      if (d === undefined) return 'undefined';
      if (Array.isArray(d)) return 'array';
      return typeof d;
    });
    
    const isExpandable = computed(() => {
      return dataType.value === 'object' || dataType.value === 'array';
    });
    
    const isEmpty = computed(() => {
      if (dataType.value === 'array') return props.data.length === 0;
      if (dataType.value === 'object') return Object.keys(props.data).length === 0;
      return false;
    });
    
    const toggle = () => {
      if (isExpandable.value) {
        isExpanded.value = !isExpanded.value;
      }
    };
    
    const formatValue = (value) => {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'string') {
        // Check if it's a timestamp string
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          return `"${value}"`;
        }
        return `"${value}"`;
      }
      if (typeof value === 'boolean') return value.toString();
      if (typeof value === 'number') {
        // Check if it's likely a timestamp
        if (value > 1600000000000 && value < 2000000000000) {
          return `${value} (${new Date(value).toISOString()})`;
        }
        return value.toString();
      }
      // Handle empty containers
      if (Array.isArray(value) && value.length === 0) return '[]';
      if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return '{}';
      return value;
    };
    
    const isElementRef = (obj) => {
      return obj && typeof obj === 'object' && 
             'elementId' in obj && 
             ('elementPath' in obj || 'elementType' in obj);
    };
    
    const formatElementRef = (ref) => {
      if (ref.elementPath?.length) {
        return ref.elementPath.join('/');
      }
      return ref.elementId;
    };
    
    // Check if a value is scalar or empty container (should be displayed inline)
    const isScalar = (value) => {
      if (value === null || value === undefined) return true;
      const type = typeof value;
      if (type === 'string' || type === 'number' || type === 'boolean') return true;
      
      // Include empty arrays and empty objects
      if (Array.isArray(value) && value.length === 0) return true;
      if (type === 'object' && value !== null && Object.keys(value).length === 0) return true;
      
      return false;
    };

    // Sort object keys for consistent display
    const sortedEntries = computed(() => {
      if (dataType.value !== 'object') return [];
      return Object.entries(props.data).sort(([a], [b]) => {
        // Put important keys first
        const priority = ['id', 'name', 'type', 'topic', 'timestamp'];
        const aIdx = priority.indexOf(a);
        const bIdx = priority.indexOf(b);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return a.localeCompare(b);
      });
    });
    
    return {
      isExpanded,
      dataType,
      isExpandable,
      isEmpty,
      toggle,
      formatValue,
      isElementRef,
      formatElementRef,
      isScalar,
      sortedEntries
    };
  },
  template: `
    <div class="json-viewer">
      <template v-if="!isExpandable">
        <span :class="'json-' + dataType">{{ formatValue(data) }}</span>
      </template>
      <template v-else-if="isElementRef(data)">
        <span class="json-element-ref">{{ formatElementRef(data) }}</span>
      </template>
      <template v-else>
        <span 
          class="json-toggle"
          @click="toggle"
          v-if="!isEmpty"
        >
          {{ isExpanded ? '▾' : '▸' }}
        </span>
        <span v-else class="json-toggle-spacer"></span>
        
        <span class="json-bracket">{{ dataType === 'array' ? '[' : '{' }}</span>
        <span v-if="!isExpanded && !isEmpty" class="json-ellipsis">...</span>
        <span v-if="isEmpty" class="json-empty">{{ dataType === 'array' ? '' : '' }}</span>
        <span v-if="!isExpanded || isEmpty" class="json-bracket">{{ dataType === 'array' ? ']' : '}' }}</span>
        
        <div v-if="isExpanded && !isEmpty" class="json-content">
          <template v-if="dataType === 'array'">
            <div v-for="(item, index) in data" :key="index" class="json-item json-array-item">
              <json-viewer :data="item" :depth="depth + 1" :expandAll="expandAll" />
            </div>
          </template>
          <template v-else>
            <div v-for="[key, value] in sortedEntries" :key="key" class="json-item">
              <span class="json-key">{{ key }}:</span>
              <template v-if="isScalar(value)">
                <span :class="'json-' + (value === null ? 'null' : 
                                       value === undefined ? 'undefined' : 
                                       Array.isArray(value) ? 'bracket' :
                                       typeof value === 'object' && value !== null ? 'bracket' :
                                       typeof value)">{{ formatValue(value) }}</span>
              </template>
              <template v-else>
                <json-viewer :data="value" :depth="depth + 1" :expandAll="expandAll" />
              </template>
            </div>
          </template>
        </div>
        <div v-if="isExpanded && !isEmpty" class="json-bracket-line">
          <span class="json-bracket">{{ dataType === 'array' ? ']' : '}' }}</span>
        </div>
      </template>
    </div>
  `
};
