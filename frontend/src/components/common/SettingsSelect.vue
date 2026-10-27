<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  id: string;
  label: string;
  modelValue: string;
  options: { value: string; label: string; desc?: string }[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();
const open = ref(false);
const active = ref(0);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const position = ref<Record<string, string>>({});
const upward = ref(false);
const selectedLabel = computed(() => props.options.find(option => option.value === props.modelValue)?.label ?? '');
const optionId = (index: number) => `${props.id}-option-${index}`;

function updatePosition() {
  if (!open.value || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const gap = 6;
  const margin = 12;
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const height = Math.min(props.options.length * 36 + 12, 300);
  upward.value = below < height && above > below;
  position.value = {
    width: `${Math.min(rect.width, window.innerWidth - margin * 2)}px`,
    left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`,
    maxHeight: `${Math.max(0, Math.min(300, upward.value ? above : below))}px`,
    ...(upward.value ? { bottom: `${window.innerHeight - rect.top + gap}px` } : { top: `${rect.bottom + gap}px` }),
  };
}

function revealActive() {
  panel.value?.querySelector(`#${optionId(active.value)}`)?.scrollIntoView({ block: 'nearest' });
}

async function show() {
  if (props.disabled || !props.options.length) return;
  active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue));
  open.value = true;
  updatePosition();
  await nextTick();
  revealActive();
}

function close() { open.value = false; }
function select(index: number) {
  if (props.disabled) return;
  const option = props.options[index];
  if (option) emit('update:modelValue', option.value);
  close();
  trigger.value?.focus();
}

async function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault(); event.stopPropagation(); close();
  } else if (event.key === 'Tab') {
    close();
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (!open.value) { await show(); return; }
    if (event.key === 'Home') active.value = 0;
    else if (event.key === 'End') active.value = props.options.length - 1;
    else active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + props.options.length) % props.options.length;
    await nextTick(); revealActive();
  } else if ((event.key === 'Enter' || event.key === ' ') && open.value) {
    event.preventDefault(); select(active.value);
  }
}

function handleOutside(event: PointerEvent) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !panel.value?.contains(target)) close();
}

watch(() => props.disabled, value => { if (value) close(); });
onMounted(() => {
  document.addEventListener('pointerdown', handleOutside);
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutside);
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});
</script>

<template>
  <button v-bind="$attrs" :id="id" ref="trigger" type="button" :disabled="disabled" role="combobox"
    :aria-label="label" :aria-expanded="open" :aria-controls="`${id}-menu`"
    :aria-activedescendant="open ? optionId(active) : undefined" aria-haspopup="listbox"
    class="settings-select-trigger" :class="{ 'is-open': open }"
    @click="open ? close() : show()" @keydown="handleKey">
    <span class="truncate">{{ selectedLabel }}</span>
    <svg class="settings-select-chevron" :class="{ 'is-open': open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <!-- 菜单移出滚动容器，避免设置弹窗裁剪选项。 -->
  <Teleport to="body">
    <Transition name="settings-select">
      <div v-if="open" :id="`${id}-menu`" ref="panel" role="listbox" :aria-label="label"
        class="settings-select-menu" :class="{ 'opens-up': upward }" :style="position" @pointerdown.prevent>
        <div v-for="(option, index) in options" :id="optionId(index)" :key="option.value" role="option"
          :aria-selected="option.value === modelValue" class="settings-select-option" :data-value="option.value"
          :class="{ 'is-active': index === active, 'is-selected': option.value === modelValue }"
          @pointermove="active = index" @click="select(index)">
          <span class="flex min-w-0 flex-col">
            <span :class="option.desc ? 'leading-snug' : 'truncate'">{{ option.label }}</span>
            <!-- 有 desc 的选项（如工作空间权限的三种模式）必须把取舍一并渲染出来，否则用户只看到档位名 -->
            <span v-if="option.desc" class="settings-select-option-desc">{{ option.desc }}</span>
          </span>
          <svg v-if="option.value === modelValue" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m5 12 4 4L19 6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../style.css";
.settings-select-trigger { @apply flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-xs text-lx-primary-soft outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed dark:border-white/15 dark:bg-black/30; transition: background-color 160ms, border-color 160ms, box-shadow 160ms; }
.settings-select-trigger:hover { @apply border-zinc-300 bg-zinc-50 dark:border-white/30 dark:bg-white/5; }
.settings-select-trigger:focus-visible, .settings-select-trigger.is-open { @apply border-gray-400 ring-2 ring-zinc-200/60 dark:border-white/40 dark:ring-white/10; }
.settings-select-chevron { @apply h-3.5 w-3.5 shrink-0 text-lx-muted; transition: transform 180ms ease; }
.settings-select-chevron.is-open { transform: rotate(180deg); }
.settings-select-menu { @apply fixed z-[1000] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 text-xs text-gray-700 shadow-[0_8px_28px_rgba(0,0,0,0.12)] dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-300 dark:shadow-[0_12px_36px_rgba(0,0,0,0.65)]; transform-origin: top center; }
.settings-select-menu.opens-up { transform-origin: bottom center; }
.settings-select-option { @apply flex min-h-9 items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer select-none; transition: background-color 120ms, color 120ms; }
.settings-select-option.is-active { @apply bg-zinc-100 text-gray-900 dark:bg-white/10 dark:text-white; }
.settings-select-option.is-selected { @apply font-medium text-gray-900 dark:text-white; }
.settings-select-option-desc { @apply mt-0.5 text-[11px] font-normal leading-snug text-lx-faint; }
.settings-select-enter-active { transition: opacity 160ms ease-out, transform 160ms ease-out; }
.settings-select-leave-active { transition: opacity 120ms ease-in, transform 120ms ease-in; pointer-events: none; }
.settings-select-enter-from, .settings-select-leave-to { opacity: 0; transform: translateY(-4px) scale(0.97); }
.opens-up.settings-select-enter-from, .opens-up.settings-select-leave-to { transform: translateY(4px) scale(0.97); }
@media (prefers-reduced-motion: reduce) {
  .settings-select-trigger, .settings-select-chevron, .settings-select-option, .settings-select-enter-active, .settings-select-leave-active { transition: none; }
}
</style>
