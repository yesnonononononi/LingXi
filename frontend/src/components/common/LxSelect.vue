<script setup lang="ts" generic="T extends string | number">
/**
 * LxSelect：全站「下拉选择」的唯一外壳。
 *
 * <p><b>为什么存在</b>：此前有两个半成品同时长大——`SettingsSelect`（键盘导航 + aria + 同宽面板，
 * 但 value 只收 string、无搜索无分组）与 `DropUpSelect`（泛型、搜索、分组折叠、头像，却没有键盘导航
 * 与 aria）。同一个交互写了两遍，能力各缺一半，任何新需求都要在两边各补一次。本组件把**行为**
 * （开合、定位、键盘、a11y、Teleport、过渡、搜索、分组折叠）收成一份，视觉差异交给
 * {@code variant}（settings / popup）与 {@code trigger} / {@code option} 插槽，
 * 两个旧组件退化为预设薄壳。</p>
 *
 * <p><b>契约（有测试钉住，改名前先改测试）</b>：根元素是 div；触发器是
 * {@code button[role=combobox][aria-haspopup=listbox]}；面板 Teleport 到 body 且 {@code role=listbox}；
 * 每个选项 {@code role=option[data-value]}；settings 预设保留 {@code settings-select-menu} /
 * {@code settings-select-option} 两个类名（历史 smoke 依赖）。</p>
 *
 * <p><b>值比较一律按字符串</b>：后端主键常是字符串而本地选项值是数字，严格 `===` 会把同一个 id
 * 判不等，表现为「值还在，下拉却回落成占位文案」。</p>
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { SelectOption } from '../../types/ui';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';

const props = defineProps<{
  modelValue: T;
  options: SelectOption<T>[];
  /** settings = 设置页同宽面板；popup = 上拉浮层（可搜索 / 分组 / 头像） */
  variant?: 'settings' | 'popup';
  /** 注意：属性全部转发到触发器 button（`inheritAttrs: false`），调用方传的
   *  `data-testid` / `data-slot` / `aria-*` 落在真正的可交互元素上。 */
  id?: string;
  /** 触发器与面板的 aria-label */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** popup 预设的触发器尺寸 */
  size?: 'md' | 'sm';
  /** popup 预设的面板水平对齐 */
  align?: 'left' | 'right';
  /** 面板宽度策略：trigger = 与触发器同宽（settings 默认）；content = 内容自适应（popup 默认） */
  panelWidth?: 'trigger' | 'content';
  searchable?: boolean;
  searchPlaceholder?: string;
  menuTitle?: string;
  /** 触发器追加 class（调用方定制外观） */
  triggerClass?: string;
  isDark?: boolean;
  /** 无匹配选项时的空态文案 */
  emptyText?: string;
}>();

defineOptions({ inheritAttrs: false });

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
  (e: 'change', value: T): void;
  (e: 'open'): void;
  (e: 'close'): void;
}>();

const { isDark: themeIsDark } = useTheme();
/**
 * 缺省布尔 prop 的坑：Vue 会把「未传的 Boolean prop」cast 成 false 而不是 undefined，
 * 所以不能写 `props.isDark ?? themeIsDark.value`（兜底永不生效）。
 */
const isDark = computed(() => (props.isDark === undefined ? themeIsDark.value : props.isDark));
const isSettings = computed(() => (props.variant ?? 'settings') === 'settings');
const isSmall = computed(() => props.size === 'sm');
const useTriggerWidth = computed(
  () => (props.panelWidth ?? (isSettings.value ? 'trigger' : 'content')) === 'trigger',
);
const isSearchable = computed(() => props.searchable === true);

const autoId = useId();
const selectId = computed(() => props.id ?? `lx-select-${autoId}`);
const menuId = computed(() => `${selectId.value}-menu`);

const isOpen = ref(false);
const opensUp = ref(false);
const activeFlat = ref(0);
const searchQuery = ref('');
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

const toKey = (value: T | null | undefined): string =>
  (value === null || value === undefined ? '' : String(value));
const isSelected = (option: SelectOption<T>): boolean => toKey(option.value) === toKey(props.modelValue);
const selectedOption = computed<SelectOption<T> | null>(() => props.options.find(isSelected) ?? null);
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? '');

const filteredOptions = computed<SelectOption<T>[]>(() => {
  if (!isSearchable.value || !searchQuery.value.trim()) return props.options;
  const query = searchQuery.value.trim().toLowerCase();
  return props.options.filter(option =>
    String(option.label).toLowerCase().includes(query)
    || String(option.description ?? '').toLowerCase().includes(query));
});

interface OptionGroup {
  key: string;
  name: string;
  count: number;
  items: { option: SelectOption<T>; flat: number }[];
}

/**
 * 按 {@code option.group} 聚组，并顺带记下「扁平索引」：键盘导航与 aria-activedescendant
 * 都按可见顺序走同一份编号，避免分组 + 搜索同时生效时索引错位。
 */
const groupedOptions = computed<OptionGroup[]>(() => {
  const groups: OptionGroup[] = [];
  const index = new Map<string, OptionGroup>();
  let flat = 0;
  for (const option of filteredOptions.value) {
    const name = String(option.group ?? '').trim();
    let group = index.get(name);
    if (!group) {
      group = { key: name, name, count: 0, items: [] };
      index.set(name, group);
      groups.push(group);
    }
    group.items.push({ option, flat: flat++ });
    group.count += 1;
    if (group.items.length === 1 && typeof option.groupCount === 'number') group.count = option.groupCount;
  }
  return groups;
});

const expandedGroups = ref<Set<string>>(new Set());
const isGroupCollapsed = (group: OptionGroup): boolean => {
  if (!group.name || searchQuery.value.trim()) return false;
  return !expandedGroups.value.has(group.name);
};
const toggleGroup = (group: OptionGroup): void => {
  if (!group.name) return;
  const next = new Set(expandedGroups.value);
  if (next.has(group.name)) next.delete(group.name);
  else next.add(group.name);
  expandedGroups.value = next;
};

/** 键盘导航的可见序列（折叠的组、被搜索过滤掉的选项都不在内）。 */
const visibleOptions = computed<SelectOption<T>[]>(() =>
  groupedOptions.value.flatMap(group =>
    (isGroupCollapsed(group) ? [] : group.items.map(item => item.option))));

const panelMaxHeight = computed(() => (isSettings.value ? 300 : 384));
const PANEL_MAX_WIDTH = 224;
const PANEL_MIN_WIDTH = 168;

function updatePosition(): void {
  if (!isOpen.value || !triggerRef.value) return;
  const rect = triggerRef.value.getBoundingClientRect();
  const margin = 8;
  const gap = isSettings.value ? 6 : 10;
  const available = window.innerWidth - margin * 2;
  const above = Math.max(0, rect.top - gap - margin);
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
  const rowHeight = isSettings.value ? 44 : 36;
  const estimate = Math.min(
    visibleOptions.value.length * rowHeight + 12 + (isSearchable.value ? 36 : 0),
    panelMaxHeight.value,
  );
  opensUp.value = below < estimate && above > below;
  const style: Record<string, string> = {
    maxHeight: `${Math.min(panelMaxHeight.value, opensUp.value ? above : below)}px`,
  };
  if (useTriggerWidth.value) {
    const width = Math.min(rect.width, available);
    style.width = `${width}px`;
    style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
  } else {
    const minWidth = Math.min(Math.max(PANEL_MIN_WIDTH, rect.width), available);
    const width = Math.min(Math.max(panelRef.value?.offsetWidth ?? minWidth, minWidth), available);
    style.minWidth = `${minWidth}px`;
    style.maxWidth = `${Math.min(PANEL_MAX_WIDTH, available)}px`;
    style.left = `${Math.max(
      margin,
      Math.min(props.align === 'right' ? rect.right - width : rect.left, window.innerWidth - width - margin),
    )}px`;
  }
  if (opensUp.value) style.bottom = `${window.innerHeight - rect.top + gap}px`;
  else style.top = `${rect.bottom + gap}px`;
  panelStyle.value = style;
}

function revealActive(): void {
  panelRef.value?.querySelector(`[data-flat="${activeFlat.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function open(): Promise<void> {
  if (props.disabled || !props.options.length) return;
  const selectedFlat = visibleOptions.value.findIndex(isSelected);
  activeFlat.value = selectedFlat >= 0 ? selectedFlat : 0;
  searchQuery.value = '';
  isOpen.value = true;
  emit('open');
  updatePosition();
  await nextTick();
  updatePosition();
  if (isSearchable.value) searchInputRef.value?.focus();
  else revealActive();
}

function close(): void {
  if (!isOpen.value) return;
  isOpen.value = false;
  searchQuery.value = '';
  emit('close');
}

const toggle = (): void => { if (isOpen.value) close(); else void open(); };

function select(option: SelectOption<T>): void {
  if (option.disabled) return;
  if (!isSelected(option)) {
    emit('update:modelValue', option.value);
    emit('change', option.value);
  }
  close();
  triggerRef.value?.focus();
}

async function handleKey(event: KeyboardEvent): Promise<void> {
  if (event.key === 'Escape' && isOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'Tab') { close(); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (!isOpen.value) { await open(); return; }
    const list = visibleOptions.value;
    if (!list.length) return;
    if (event.key === 'Home') activeFlat.value = 0;
    else if (event.key === 'End') activeFlat.value = list.length - 1;
    else {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeFlat.value = (activeFlat.value + step + list.length) % list.length;
    }
    await nextTick();
    revealActive();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && isOpen.value) {
    event.preventDefault();
    const option = visibleOptions.value[activeFlat.value];
    if (option) select(option);
  }
}

const handleSearchEnter = (): void => {
  const matched = visibleOptions.value.find(option => !option.disabled);
  if (matched) select(matched);
};

/** 点击面板外的任意位置关闭。panel 在 body 上，必须单独排除。 */
const closeIfOutside = (target: Node | null): void => {
  if (!target) return;
  if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) return;
  close();
};
const onPointerDown = (event: PointerEvent): void => closeIfOutside(event.target as Node);
const onMouseDown = (event: MouseEvent): void => closeIfOutside(event.target as Node);
const onDocumentKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && isOpen.value) close();
};

function optionClasses(option: SelectOption<T>, flat: number): unknown[] {
  const selected = isSelected(option);
  const active = activeFlat.value === flat;
  if (isSettings.value) {
    return ['settings-select-option', {
      'is-active': active,
      'is-selected': selected,
      'is-disabled': option.disabled === true,
    }];
  }
  return [
    'px-3 py-2 rounded-xl text-xs flex items-center gap-2 transition-colors select-none',
    option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
    selected
      ? (isDark.value
        ? 'border border-white/85 bg-white/[0.12] text-white font-medium shadow-[0_0_14px_rgba(255,255,255,0.22)]'
        : 'bg-zinc-100 text-zinc-900 font-normal')
      : (option.disabled
        ? ''
        : (active
          ? (isDark.value ? 'bg-white/10 text-zinc-300' : 'bg-zinc-50 text-zinc-700')
          : (isDark.value ? 'text-zinc-300' : 'text-zinc-700'))),
  ];
}

watch(() => props.disabled, value => { if (value) close(); });
watch(() => props.options.length, length => { if (!length) close(); });

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  // popup 预设历史上用 mousedown 关面板（输入区 mousedown 被 preventDefault 时 pointerdown 不一定来）。
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('mousedown', onMouseDown);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});

defineExpose({ open, close });
</script>

<template>
  <div ref="rootRef" class="relative" :class="isSettings ? '' : 'inline-flex items-center'">
    <button
      :id="selectId"
      ref="triggerRef"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="isOpen"
      :aria-controls="menuId"
      :aria-activedescendant="isOpen ? `${selectId}-option-${activeFlat}` : undefined"
      :disabled="disabled"
      :class="[
        isSettings ? 'settings-select-trigger' : 'lx-select-popup-trigger',
        isSettings ? { 'is-open': isOpen } : '',
        !isSettings ? 'flex items-center justify-between gap-1.5 rounded-lg transition outline-none border-lx-border-strong' : '',
        !isSettings && !triggerClass ? (isSmall ? 'h-8 px-2.5 py-1.5' : 'h-9 px-3 py-2') : '',
        !isSettings ? (disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer') : '',
        !isSettings ? (isDark ? 'hover:bg-white/5' : 'hover:bg-black/5') : '',
        triggerClass,
      ]"
      v-bind="$attrs"
      @click="toggle"
      @keydown="handleKey"
    >
      <slot name="trigger" :isOpen="isOpen" :selected="selectedOption" :label="displayLabel">
        <span class="truncate" :class="{ 'text-lx-faint': !selectedOption }">{{ displayLabel }}</span>
        <svg class="lx-select-chevron" :class="{ 'is-open': isOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </slot>
    </button>

    <Teleport to="body">
      <Transition :name="isSettings ? 'settings-select' : 'lx-select-popup'">
        <div
          v-if="isOpen"
          :id="menuId"
          ref="panelRef"
          role="listbox"
          :aria-label="label"
          :style="panelStyle"
          :class="isSettings
            ? ['settings-select-menu', { 'opens-up': opensUp }]
            : [
              'lx-select-popup-menu fixed flex flex-col overflow-hidden rounded-2xl border p-1.5 shadow-2xl backdrop-blur-2xl z-[1000] min-w-[10.5rem] max-w-[14rem] max-h-96',
              isDark ? 'dark bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.95)]' : 'light bg-white border-zinc-200/90 text-zinc-800 shadow-[0_12px_30px_rgba(0,0,0,0.12)]',
            ]"
          @pointerdown.prevent
        >
          <div v-if="isSearchable" class="px-1.5 pt-1 pb-1.5 shrink-0">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              :placeholder="searchPlaceholder ?? t('common.searchPlaceholder')"
              class="w-full px-2 py-1 text-xs border rounded-lg outline-none select-text transition"
              :class="isDark
                ? 'bg-white/[0.06] border-lx-border text-white placeholder-lx-faint focus:border-cyan-400/60'
                : 'bg-transparent border-lx-border text-zinc-800 placeholder-lx-faint focus:border-blue-500'"
              @keydown.stop
              @keydown.esc="close"
              @keydown.enter="handleSearchEnter"
            />
          </div>

          <div
            v-if="menuTitle"
            class="px-2.5 py-1 font-semibold uppercase tracking-wider text-lx-fs-xs text-lx-faint"
          >{{ menuTitle }}</div>

          <div class="min-h-0 overflow-y-auto space-y-0.5" :class="isSettings ? '' : 'scrollbar-thin max-h-80'">
            <div v-if="!visibleOptions.length" class="px-3 py-2 text-xs text-lx-faint text-center">
              {{ emptyText ?? t('common.noOptions') }}
            </div>

            <template v-for="(group, groupIndex) in groupedOptions" :key="group.key || `__ungrouped_${groupIndex}`">
              <button
                v-if="group.name"
                type="button"
                :aria-expanded="!isGroupCollapsed(group)"
                :title="isGroupCollapsed(group) ? t('common.expand') : t('common.collapse')"
                class="w-full px-2.5 pt-1.5 pb-0.5 flex items-center gap-1.5 select-none cursor-pointer rounded-lg bg-transparent border-0 text-left transition-colors"
                :class="isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'"
                @click.stop="toggleGroup(group)"
              >
                <span class="flex-1 min-w-0 text-lx-fs-xs font-bold uppercase tracking-wider truncate text-lx-secondary">{{ group.name }}</span>
                <span class="shrink-0 px-1.5 py-px rounded-md text-lx-fs-xs leading-none bg-lx-surface-selected text-lx-muted">{{ group.count }}</span>
                <svg
                  class="w-2.5 h-2.5 shrink-0 transition-transform duration-200 text-lx-faint"
                  :class="isGroupCollapsed(group) ? 'rotate-90' : 'rotate-180'"
                  viewBox="0 0 1024 1024"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M838.116 732.779 877.7 693.195 511.979 327.549 146.3 693.195 185.883 732.779 512.003 406.652Z" />
                </svg>
              </button>

              <template v-if="!isGroupCollapsed(group)">
                <div
                  v-for="item in group.items"
                  :id="`${selectId}-option-${item.flat}`"
                  :key="item.option.value"
                  role="option"
                  :data-value="String(item.option.value)"
                  :data-flat="item.flat"
                  :aria-selected="isSelected(item.option)"
                  :aria-disabled="item.option.disabled ? 'true' : undefined"
                  :class="optionClasses(item.option, item.flat)"
                  @pointermove="activeFlat = item.flat"
                  @click="select(item.option)"
                >
                  <slot
                    name="option"
                    :option="item.option"
                    :index="item.flat"
                    :selected="isSelected(item.option)"
                    :active="activeFlat === item.flat"
                  >
                    <span class="truncate">{{ item.option.label }}</span>
                  </slot>
                </div>
              </template>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
@reference "../../style.css";

/* ---- settings 预设：与触发器同宽、描述两行、勾选对钩 ---- */
.settings-select-trigger {
  @apply flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-xs text-lx-primary-soft outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed dark:border-white/15 dark:bg-black/30;
  transition: background-color 160ms, border-color 160ms, box-shadow 160ms;
}
.settings-select-trigger:hover {
  @apply border-zinc-300 bg-zinc-50 dark:border-white/30 dark:bg-white/5;
}
.settings-select-trigger:focus-visible,
.settings-select-trigger.is-open {
  @apply border-zinc-400 ring-2 ring-zinc-200/60 dark:border-white/40 dark:ring-white/10;
}
.lx-select-chevron {
  @apply h-3.5 w-3.5 shrink-0 text-lx-muted;
  transition: transform 180ms ease;
}
.lx-select-chevron.is-open { transform: rotate(180deg); }
.settings-select-menu {
  @apply fixed z-[1000] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 text-xs text-zinc-700 shadow-[0_8px_28px_rgba(0,0,0,0.12)] dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-300 dark:shadow-[0_12px_36px_rgba(0,0,0,0.65)];
  transform-origin: top center;
}
.settings-select-menu.opens-up { transform-origin: bottom center; }
.settings-select-option {
  @apply flex min-h-9 items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer select-none;
  transition: background-color 120ms, color 120ms;
}
.settings-select-option.is-active {
  @apply bg-zinc-100 text-zinc-900 dark:bg-white/10 dark:text-white;
}
.settings-select-option.is-selected {
  @apply font-medium text-zinc-900 dark:text-white;
}
.settings-select-option.is-disabled { @apply opacity-40 cursor-not-allowed; }
.settings-select-option-desc {
  @apply mt-0.5 line-clamp-2 text-lx-fs-sm font-normal leading-snug text-lx-faint;
}
.settings-select-enter-active {
  transition: opacity 160ms ease-out, transform 160ms ease-out;
}
.settings-select-leave-active {
  transition: opacity 120ms ease-in, transform 120ms ease-in;
  pointer-events: none;
}
.settings-select-enter-from,
.settings-select-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.97);
}
.opens-up.settings-select-enter-from,
.opens-up.settings-select-leave-to {
  transform: translateY(4px) scale(0.97);
}

/* ---- popup 预设：上拉浮层（进入/离开沿用原 150ms/100ms 手感） ---- */
.lx-select-popup-menu { transform-origin: top center; }
.lx-select-popup-enter-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}
.lx-select-popup-leave-active {
  transition: opacity 100ms ease-in, transform 100ms ease-in;
  pointer-events: none;
}
.lx-select-popup-enter-from,
.lx-select-popup-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  .settings-select-trigger,
  .lx-select-chevron,
  .settings-select-option,
  .settings-select-enter-active,
  .settings-select-leave-active,
  .lx-select-popup-enter-active,
  .lx-select-popup-leave-active {
    transition: none;
  }
}
</style>
