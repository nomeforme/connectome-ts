import { ref, computed, watch } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import { truncate, shorten } from '../utils.js';

const FacetNode = {
  name: 'FacetNode',
  props: {
    facet: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    expandedDepth: { type: Number, default: 1 }
  },
  emits: ['show-detail'],
  setup(props, { emit }) {
    const hasChildren = computed(() => props.facet.children && props.facet.children.length > 0);
    const isExpanded = ref(props.depth < props.expandedDepth);

    watch(
      () => props.expandedDepth,
      value => {
        if (props.depth < value) {
          isExpanded.value = true;
        }
      }
    );

    const toggle = () => {
      if (!hasChildren.value) return;
      isExpanded.value = !isExpanded.value;
    };

    const showFacetDetail = () => {
      emit('show-detail', {
        type: 'facet',
        title: `Facet · ${props.facet.displayName || props.facet.id}`,
        subtitle: props.facet.type,
        payload: props.facet
      });
    };

    return {
      hasChildren,
      isExpanded,
      toggle,
      showFacetDetail,
      truncate,
      shorten
    };
  },
  template: `
    <li class="compact-facet-item">
      <div class="compact-facet-row" :style="{ paddingLeft: depth * 16 + 'px' }">
        <span class="tree-connector" v-if="depth > 0"></span>
        <button
          v-if="hasChildren"
          class="compact-toggle"
          @click.stop="toggle"
        >
          {{ isExpanded ? '▾' : '▸' }}
        </button>
        <span v-else class="compact-toggle-spacer"></span>
        <div class="compact-facet-info" @click="showFacetDetail">
          <span class="veil-facet-name">{{ facet.displayName || facet.name || facet.id }}</span>
          <span class="veil-facet-type">({{ facet.type }})</span>
          <span v-if="facet.content" class="veil-facet-content">{{ facet.content }}</span>
          <span v-if="facet.components?.length" class="veil-facet-comps">[{{ facet.components.length }}c]</span>
        </div>
      </div>
      <ul v-if="hasChildren && isExpanded" class="compact-facet-children">
        <facet-node
          v-for="child in facet.children"
          :key="child.id"
          :facet="child"
          :depth="depth + 1"
          :expanded-depth="expandedDepth"
          @show-detail="$emit('show-detail', $event)"
        />
      </ul>
    </li>
  `
};

export const InlineFacetTree = {
  name: 'InlineFacetTree',
  props: {
    facet: { type: Object, required: true },
    depth: { type: Number, default: 0 }
  },
  setup(props, { emit }) {
    const showDetail = () => {
      emit('show-detail', {
        title: 'Facet Details',
        subtitle: `${props.facet.name || props.facet.id} (${props.facet.type})`,
        payload: props.facet
      });
    };

    const hasChildren = computed(() => props.facet.children?.length > 0);
    
    const formatValue = (value) => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };

    return { 
      showDetail, 
      hasChildren, 
      formatValue,
      truncate: (value, max) => truncate(value, max),
      shorten: (value, max) => shorten(value, max) 
    };
  },
  template: `
    <div class="inline-tree-node">
      <div 
        class="inline-tree-row" 
        :style="{ paddingLeft: depth * 16 + 'px' }"
        @click="showDetail"
      >
        <span class="tree-connector" v-if="depth > 0"></span>
        <span class="inline-tree-name">{{ facet.name || facet.id || facet.type || 'facet' }}</span>
        <span class="inline-tree-type">({{ facet.type || 'unknown' }})</span>
        <span v-if="facet.content" class="inline-tree-content">{{ facet.content }}</span>
        <span v-if="facet.attributes" class="inline-tree-attrs-inline">
          <template v-for="(value, key, index) in facet.attributes" :key="key">
            <span v-if="index > 0" class="attr-separator">|</span>
            <span class="attr-key">{{ key }}:</span>
            <span class="attr-value">{{ formatValue(value) }}</span>
          </template>
        </span>
        <span v-if="facet.components?.length" class="inline-tree-components">[{{ facet.components.length }}c]</span>
      </div>
      <div v-if="hasChildren" class="inline-tree-children">
        <inline-facet-tree
          v-for="(child, idx) in facet.children"
          :key="child.id || idx"
          :facet="child"
          :depth="depth + 1"
          @show-detail="$emit('show-detail', $event)"
        />
      </div>
    </div>
  `
};

export const FacetTree = {
  name: 'FacetTree',
  props: {
    facets: { type: Array, required: true },
    expandedDepth: { type: Number, default: 1 }
  },
  emits: ['show-detail'],
  components: { FacetNode },
  template: `
    <ul class="facet-tree">
      <facet-node
        v-for="facet in facets"
        :key="facet.id"
        :facet="facet"
        :depth="0"
        :expanded-depth="expandedDepth"
        @show-detail="$emit('show-detail', $event)"
      />
    </ul>
  `
};
