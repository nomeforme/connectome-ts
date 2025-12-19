export const ComponentList = {
  name: 'ComponentList',
  props: {
    components: { type: Array, required: true }
  },
  emits: ['select'],
  methods: {
    getConstraintLabel(component) {
      const constraints = component.constraints || [];
      const priority = constraints.find(c => c.type === 'priority');
      if (priority) return priority.priority;
      if (constraints.length > 0) return constraints.map(c => c.type).join(',');
      return '—';
    },
    getConstraintTooltip(component) {
      const constraints = component.constraints || [];
      if (constraints.length === 0) return 'No constraints';
      return constraints.map(c =>
        c.type === 'priority' ? `priority: ${c.priority}` : c.type
      ).join(', ');
    }
  },
  template: `
    <div v-if="components.length" class="component-list">
      <div
        v-for="(component, index) in components"
        :key="component.id || index"
        class="component-item"
        :class="{ disabled: !component.enabled }"
        @click="$emit('select', component)"
      >
        <span class="component-index">#{{ component.index || index }}</span>
        <span class="component-name">{{ component.name }}</span>
        <span class="component-priority" :title="getConstraintTooltip(component)">
          {{ getConstraintLabel(component) }}
        </span>
        <span class="component-status" v-if="!component.enabled">⏸</span>
      </div>
    </div>
    <div v-else class="text-muted" style="padding: 12px;">No components registered.</div>
  `
};
