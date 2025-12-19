import { computed } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import { formatComponentSummary, shorten, truncate } from '../utils.js';

export const ElementTree = {
  name: 'ElementTree',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    expanded: { type: Object, required: true }
  },
  emits: ['toggle', 'show-detail'],
  setup(props, { emit }) {
    const hasChildren = computed(() => props.node.children && props.node.children.length > 0);
    const isExpanded = computed(() => {
      if (!hasChildren.value) return false;
      const current = props.expanded[props.node.id];
      return current === undefined ? false : current;
    });

    const toggle = () => {
      if (!hasChildren.value) return;
      emit('toggle', props.node.id);
    };

    const showElementDetail = () => {
      emit('show-detail', {
        type: 'element',
        title: `Element · ${props.node.name}`,
        subtitle: props.node.type,
        payload: props.node
      });
    };

    const showComponentDetail = comp => {
      emit('show-detail', {
        type: 'component',
        title: `Component · ${comp.type}`,
        subtitle: props.node.name,
        payload: comp
      });
    };

    const componentSummary = comp => formatComponentSummary(comp.state);

    return {
      hasChildren,
      isExpanded,
      toggle,
      showElementDetail,
      showComponentDetail,
      componentSummary,
      shorten,
      truncate
    };
  },
  template: `
    <li class="compact-tree-item">
      <div class="compact-tree-row" :style="{ paddingLeft: depth * 16 + 'px' }">
        <span class="tree-connector" v-if="depth > 0"></span>
        <button
          v-if="hasChildren"
          class="compact-toggle"
          @click.stop="toggle"
        >
          {{ isExpanded ? '▾' : '▸' }}
        </button>
        <span v-else class="compact-toggle-spacer"></span>
        <div class="compact-element-info" @click="showElementDetail">
          <span class="element-name">{{ node.name }}</span>
          <span class="element-type">({{ node.type }})</span>
          <span v-if="node.content" class="element-content">{{ node.content }}</span>
          <span v-if="node.components?.length" class="element-comps">[{{ node.components.length }}c]</span>
        </div>
      </div>
      <div v-if="node.components?.length" class="compact-components">
        <div
          v-for="(comp, index) in node.components"
          :key="index"
          class="compact-component-row"
          :style="{ paddingLeft: (depth + 1) * 16 + 'px' }"
          @click.stop="showComponentDetail(comp)"
        >
          <span class="component-marker">○</span>
          <span class="component-name">{{ comp.type }}</span>
          <span v-if="componentSummary(comp)" class="component-summary">{{ componentSummary(comp) }}</span>
        </div>
      </div>
      <ul v-if="hasChildren && isExpanded" class="compact-tree-children">
        <element-tree
          v-for="child in node.children"
          :key="child.id"
          :node="child"
          :depth="depth + 1"
          :expanded="expanded"
          @toggle="$emit('toggle', $event)"
          @show-detail="$emit('show-detail', $event)"
        />
      </ul>
    </li>
  `
};
