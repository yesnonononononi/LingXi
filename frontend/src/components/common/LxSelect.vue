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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type CSSProperties } from 'vue';
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconArray } from '@hugeicons/vue';
import type { SelectOption } from '../../types/ui';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';

const props = withDefaults(defineProps<{
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
}>(), {
  isDark: undefined,
  disabled: false,
  searchable: false,
});

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
const pillLive = ref(false);
let pillInstant = true;
const searchQuery = ref('');
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const pillRef = ref<HTMLSpanElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

/** GlideSelect 视觉令牌：随主题明暗切换，同时挂到根节点与 Teleport 面板确保变量作用域完整 */
const glideTokens = computed<CSSProperties>(() => {
  const radius = isSettings.value ? 16 : 12;
  const innerRadius = Math.max(3, radius - 4);
  return {
    '--gs-accent': isDark.value ? '#f5f5f5' : '#18181b',
    '--gs-surface': isDark.value ? '#27272a' : '#ffffff',
    '--gs-highlight': isDark.value ? '#3f3f46' : '#e4e4e7',
    '--gs-text': isDark.value ? '#f5f5f5' : '#18181b',
    '--gs-radius': `${radius}px`,
    '--gs-inner-radius': `${innerRadius}px`,
    '--gs-pop': '180ms',
    '--gs-pop-out': '120ms',
    '--gs-glide': '220ms',
  } as CSSProperties;
});

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

const expandedGroups = ref<Set<string>>(new Set());
const hoveredGroupKey = ref<string | null>(null);
const isGroupCollapsed = (group: { name: string }): boolean => {
  if (!group.name || searchQuery.value.trim()) return false;
  return !expandedGroups.value.has(group.name);
};

/**
 * 按 {@code option.group} 聚组，并只为当前可见选项分配连续的扁平索引：
 * 折叠分组不占编号，保证键盘导航、aria-activedescendant 与滑动胶囊位置严格一致。
 */
const groupedOptions = computed<OptionGroup[]>(() => {
  const groups: OptionGroup[] = [];
  const index = new Map<string, OptionGroup>();
  for (const option of filteredOptions.value) {
    const name = String(option.group ?? '').trim();
    let group = index.get(name);
    if (!group) {
      group = { key: name, name, count: 0, items: [] };
      index.set(name, group);
      groups.push(group);
    }
    group.items.push({ option, flat: -1 });
    group.count += 1;
    if (group.items.length === 1 && typeof option.groupCount === 'number') group.count = option.groupCount;
  }
  let flat = 0;
  for (const group of groups) {
    if (isGroupCollapsed(group)) continue;
    for (const item of group.items) {
      item.flat = flat++;
    }
  }
  return groups;
});

const toggleGroup = async (group: OptionGroup): Promise<void> => {
  if (!group.name) return;
  const next = new Set(expandedGroups.value);
  if (next.has(group.name)) next.delete(group.name);
  else next.add(group.name);
  expandedGroups.value = next;
  hoveredGroupKey.value = group.key;
  pillLive.value = true;
  await nextTick();
  updatePosition();
  updatePill(true);
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
    '--gs-origin': `${opensUp.value ? 'bottom' : 'top'} ${props.align ?? 'left'}`,
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

/** 同步滑动胶囊位置：支持动态行高与分组头，首次显现瞬移、后续移动顺滑滑动 */
function updatePill(instant = false): void {
  const pill = pillRef.value;
  const list = listRef.value;
  if (!pill || !list || !isOpen.value || !pillLive.value) {
    if (pill) pill.style.opacity = '0';
    return;
  }
  const selector = hoveredGroupKey.value
    ? `[data-group-key="${CSS.escape(hoveredGroupKey.value)}"]`
    : `[data-flat="${activeFlat.value}"]`;
  const row = list.querySelector<HTMLElement>(selector);
  if (!row) {
    pill.style.opacity = '0';
    return;
  }
  const jump = instant || pillInstant || pill.style.opacity !== '1';
  pill.style.transitionDuration = jump ? '0ms, 0ms, 150ms' : '';
  pill.style.transform = `translateY(${row.offsetTop}px)`;
  pill.style.height = `${row.offsetHeight}px`;
  pill.style.opacity = '1';
  pillInstant = false;
}

function revealActive(): void {
  panelRef.value?.querySelector(`[data-flat="${activeFlat.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function open(): Promise<void> {
  if (props.disabled || !props.options.length) return;
  const selectedFlat = visibleOptions.value.findIndex(isSelected);
  hoveredGroupKey.value = null;
  activeFlat.value = selectedFlat >= 0 ? selectedFlat : 0;
  pillLive.value = selectedFlat >= 0;
  pillInstant = true;
  searchQuery.value = '';
  isOpen.value = true;
  emit('open');
  updatePosition();
  await nextTick();
  updatePosition();
  updatePill(true);
  if (isSearchable.value) searchInputRef.value?.focus();
  else revealActive();
}

function close(): void {
  if (!isOpen.value) return;
  isOpen.value = false;
  hoveredGroupKey.value = null;
  pillLive.value = false;
  searchQuery.value = '';
  emit('close');
}

const toggle = (): void => { if (isOpen.value) close(); else void open(); };

function select(option: SelectOption<T>, viaKey = false): void {
  if (option.disabled) return;
  if (!isSelected(option)) {
    if (!viaKey && rootRef.value) rootRef.value.dataset.swap = '';
    emit('update:modelValue', option.value);
    emit('change', option.value);
  }
  close();
  triggerRef.value?.focus();
}

const onAnimationEnd = (event: AnimationEvent): void => {
  if (event.animationName === 'gs-swap' && rootRef.value) {
    delete rootRef.value.dataset.swap;
  }
};

const onOptionHover = (flat: number): void => {
  hoveredGroupKey.value = null;
  activeFlat.value = flat;
  pillLive.value = true;
  updatePill(false);
};

const onGroupHover = (groupKey: string): void => {
  hoveredGroupKey.value = groupKey;
  pillLive.value = true;
  updatePill(false);
};

const onListLeave = (): void => {
  hoveredGroupKey.value = null;
  pillLive.value = false;
  if (pillRef.value) pillRef.value.style.opacity = '0';
};

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
    hoveredGroupKey.value = null;
    if (event.key === 'Home') activeFlat.value = 0;
    else if (event.key === 'End') activeFlat.value = list.length - 1;
    else {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeFlat.value = (activeFlat.value + step + list.length) % list.length;
    }
    pillLive.value = true;
    await nextTick();
    updatePill(false);
    revealActive();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && isOpen.value) {
    event.preventDefault();
    const option = visibleOptions.value[activeFlat.value];
    if (option) select(option, true);
  }
}

const handleSearchEnter = (): void => {
  const matched = visibleOptions.value.find(option => !option.disabled);
  if (matched) select(matched, true);
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
    'lx-select-popup-option relative z-[1] px-2.5 py-2 text-xs flex items-center gap-2 transition-colors select-none',
    option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
    selected ? 'font-medium' : '',
  ];
}

watch(() => props.disabled, value => { if (value) close(); });
watch(() => props.options.length, length => { if (!length) close(); });
watch(searchQuery, async () => {
  if (!isOpen.value) return;
  hoveredGroupKey.value = null;
  activeFlat.value = 0;
  pillLive.value = false;
  await nextTick();
  updatePosition();
  updatePill(true);
});

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
  <div
    ref="rootRef"
    class="group relative"
    :class="isSettings ? '' : 'inline-flex items-center'"
    :style="glideTokens"
    @animationend="onAnimationEnd"
  >
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
        !isSettings ? 'flex items-center justify-between gap-1.5 outline-none select-none touch-manipulation enabled:active:scale-[0.97] motion-reduce:enabled:active:scale-100' : '',
        !isSettings && !triggerClass ? (isSmall ? 'h-8 px-2.5 py-1.5' : 'h-9 px-3 py-2') : '',
        !isSettings ? (disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer') : '',
        triggerClass,
      ]"
      v-bind="$attrs"
      @click="toggle"
      @keydown="handleKey"
    >
      <slot name="trigger" :isOpen="isOpen" :selected="selectedOption" :label="displayLabel">
        <span
          :key="toKey(modelValue)"
          class="truncate group-data-[swap]:animate-[gs-swap_160ms_ease] motion-reduce:group-data-[swap]:animate-none"
          :class="{ 'opacity-60': !selectedOption }"
        >{{ displayLabel }}</span>
        <HugeiconsIcon
          :icon="(ArrowDown01Icon as IconArray)"
          :size="12"
          :stroke-width="2.5"
          class="lx-select-chevron"
          :class="{ 'is-open': isOpen }"
          aria-hidden="true"
        />
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
          :style="[glideTokens, panelStyle]"
          :class="isSettings
            ? ['settings-select-menu', { 'opens-up': opensUp }]
            : [
              'lx-select-popup-menu fixed flex flex-col overflow-hidden p-1 z-[1000] min-w-[10.5rem] max-w-[14rem] max-h-96',
              isDark ? 'dark border border-white/10' : 'light border border-zinc-200/80',
            ]"
          @pointerdown.prevent
        >
          <div v-if="isSearchable" class="px-0.5 pt-0.5 pb-1.5 shrink-0">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              :placeholder="searchPlaceholder ?? t('common.searchPlaceholder')"
              class="w-full px-2.5 py-1.5 text-xs border outline-none select-text transition"
              style="border-radius: var(--gs-inner-radius)"
              :class="isDark
                ? 'bg-white/[0.06] border-white/10 text-white placeholder-lx-faint focus:border-white/30'
                : 'bg-zinc-50 border-zinc-200 text-zinc-800 placeholder-lx-faint focus:border-zinc-400'"
              @keydown.stop
              @keydown.esc="close"
              @keydown.enter="handleSearchEnter"
            />
          </div>

          <div
            v-if="menuTitle"
            class="px-2.5 py-1 font-semibold uppercase tracking-wider text-lx-fs-xs text-lx-faint"
          >{{ menuTitle }}</div>

          <div
            ref="listRef"
            class="group/list relative min-h-0 overflow-y-auto grid gap-px"
            :class="isSettings ? '' : 'scrollbar-thin max-h-80'"
            :data-live="pillLive ? '' : undefined"
            @pointerleave="onListLeave"
          >
            <span
              ref="pillRef"
              aria-hidden="true"
              class="lx-select-glide-pill"
            />

            <div v-if="!filteredOptions.length" class="relative z-[1] px-3 py-2 text-xs text-lx-faint text-center">
              {{ emptyText ?? t('common.noOptions') }}
            </div>

            <template v-for="(group, groupIndex) in groupedOptions" :key="group.key || `__ungrouped_${groupIndex}`">
              <button
                v-if="group.name"
                type="button"
                :data-group-key="group.key"
                :aria-expanded="!isGroupCollapsed(group)"
                :title="isGroupCollapsed(group) ? t('common.expand') : t('common.collapse')"
                class="relative z-[1] w-full min-h-8 px-2.5 py-1.5 flex items-center gap-1.5 select-none cursor-pointer bg-transparent border-0 text-left"
                style="border-radius: var(--gs-inner-radius)"
                @pointerover="onGroupHover(group.key)"
                @pointermove="onGroupHover(group.key)"
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
                  @pointerover="onOptionHover(item.flat)"
                  @pointermove="onOptionHover(item.flat)"
                  @click="select(item.option)"
                >
                  <slot
                    name="option"
                    :option="item.option"
                    :index="item.flat"
                    :selected="isSelected(item.option)"
                    :active="activeFlat === item.flat"
                  >
                    <span class="flex-1 min-w-0 font-medium truncate">{{ item.option.label }}</span>
                    <span
                      v-if="item.option.description"
                      class="shrink-0 text-[11px]"
                      style="color: color-mix(in srgb, var(--gs-text) 55%, transparent)"
                    >
                      {{ item.option.description }}
                    </span>
                    <HugeiconsIcon
                      v-if="isSelected(item.option)"
                      :icon="(Tick02Icon as IconArray)"
                      :size="13"
                      :stroke-width="2.5"
                      class="shrink-0"
                      style="color: var(--gs-accent)"
                      aria-hidden="true"
                    />
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

@keyframes gs-swap {
  from {
    opacity: 0.6;
    filter: blur(2px);
  }
}

/* ---- 滑动高亮胶囊（GlideSelect 核心视觉） ---- */
.lx-select-glide-pill {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  opacity: 0;
  pointer-events: none;
  border-radius: var(--gs-inner-radius);
  background: var(--gs-highlight);
  transition:
    transform var(--gs-glide) cubic-bezier(0.23, 1, 0.32, 1),
    height var(--gs-glide) cubic-bezier(0.23, 1, 0.32, 1),
    opacity 150ms ease;
}

/* ---- settings 预设：与触发器同宽、描述两行、勾选对钩 ---- */
.settings-select-trigger {
  @apply flex w-full items-center justify-between gap-3 border border-zinc-200 px-3 py-2 text-left text-xs outline-none cursor-pointer select-none touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed dark:border-white/15;
  border-radius: var(--gs-inner-radius);
  background: var(--gs-surface);
  color: var(--gs-text);
  transition:
    background-color 100ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease,
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.settings-select-trigger:not(:disabled):active {
  transform: scale(0.97);
}
.settings-select-trigger:hover {
  @apply border-zinc-300 dark:border-white/30;
  background: color-mix(in srgb, var(--gs-highlight) 60%, var(--gs-surface));
}
.settings-select-trigger:focus-visible,
.settings-select-trigger.is-open {
  @apply border-zinc-400 ring-2 ring-zinc-200/60 dark:border-white/40 dark:ring-white/10;
  background: color-mix(in srgb, var(--gs-highlight) 60%, var(--gs-surface));
}
.lx-select-chevron {
  @apply shrink-0;
  color: color-mix(in srgb, var(--gs-text) 55%, transparent);
  transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
.lx-select-chevron.is-open { transform: rotate(180deg); }

.settings-select-menu {
  @apply fixed z-[1000] overflow-y-auto border border-zinc-200 p-1 text-xs dark:border-white/15;
  border-radius: var(--gs-radius);
  background: var(--gs-surface);
  color: var(--gs-text);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 22%, transparent);
  transform-origin: var(--gs-origin, top left);
}
.settings-select-menu.opens-up { transform-origin: var(--gs-origin, bottom left); }
.settings-select-option {
  @apply relative z-[1] flex min-h-9 items-center justify-between gap-3 px-3 py-2 cursor-pointer select-none;
  border-radius: var(--gs-inner-radius);
  color: var(--gs-text);
  transition: background-color 150ms ease, color 120ms ease;
}
.settings-select-option[aria-selected="true"] {
  background: color-mix(in srgb, var(--gs-highlight) 60%, transparent);
}
:deep([data-live]) .settings-select-option[aria-selected="true"],
.group\/list[data-live] .settings-select-option[aria-selected="true"] {
  background: transparent;
}
.settings-select-option.is-selected {
  @apply font-medium;
}
.settings-select-option.is-disabled { @apply opacity-40 cursor-not-allowed; }
.settings-select-option-desc {
  @apply mt-0.5 line-clamp-2 text-lx-fs-sm font-normal leading-snug text-lx-faint;
}
.settings-select-enter-active {
  transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.settings-select-leave-active {
  transition: opacity 120ms cubic-bezier(0.23, 1, 0.32, 1), transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  pointer-events: none;
}
.settings-select-enter-from,
.settings-select-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

/* ---- popup 预设：GlideSelect 质感浮层 ---- */
.lx-select-popup-trigger {
  border-radius: var(--gs-inner-radius);
  color: var(--gs-text);
  transition: background-color 100ms ease, transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.lx-select-popup-trigger:not(:disabled):hover,
.lx-select-popup-trigger[aria-expanded="true"] {
  background: color-mix(in srgb, var(--gs-highlight) 60%, var(--gs-surface));
}
.lx-select-popup-menu {
  border-radius: var(--gs-radius);
  background: var(--gs-surface);
  color: var(--gs-text);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 22%, transparent);
  transform-origin: var(--gs-origin, top left);
}
.lx-select-popup-option {
  border-radius: var(--gs-inner-radius);
  color: var(--gs-text);
}
.lx-select-popup-option[aria-selected="true"] {
  background: color-mix(in srgb, var(--gs-highlight) 60%, transparent);
}
.group\/list[data-live] .lx-select-popup-option[aria-selected="true"] {
  background: transparent;
}
.lx-select-popup-enter-active {
  transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.lx-select-popup-leave-active {
  transition: opacity 120ms cubic-bezier(0.23, 1, 0.32, 1), transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  pointer-events: none;
}
.lx-select-popup-enter-from,
.lx-select-popup-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

@media (prefers-reduced-motion: reduce) {
  .lx-select-glide-pill,
  .settings-select-trigger,
  .lx-select-popup-trigger,
  .lx-select-chevron,
  .settings-select-option,
  .settings-select-enter-active,
  .settings-select-leave-active,
  .lx-select-popup-enter-active,
  .lx-select-popup-leave-active {
    transition: none;
  }
  .settings-select-trigger:not(:disabled):active {
    transform: none;
  }
}
</style>
