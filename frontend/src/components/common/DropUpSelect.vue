<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SelectOption } from '../../types/ui';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import { isImageAvatar } from '../../utils/avatar';
import { isBuiltInProviderIcon } from '../../utils/providerIcons';
import ProviderIcon from '../model/ProviderIcon.vue';

const props = defineProps<{
  /** 当前选中值 (配合 v-model 使用) */
  modelValue: T;
  /** 选项列表 */
  options: SelectOption<T>[];
  isDark?: boolean;
  placeholder?: string;
  /** 面板相对触发器的水平对齐方式 */
  align?: 'left' | 'right';
  disabled?: boolean;
  /** 面板顶部标题，为空则不展示 */
  menuTitle?: string;
  /** 是否开启顶部实时搜索输入框，默认 true */
  searchable?: boolean;
  /** 搜索框 placeholder，默认 '搜索...' */
  searchPlaceholder?: string;
  /** 触发器额外 class */
  triggerClass?: string;
  /** 触发器尺寸：md 默认，sm 更小巧 */
  size?: 'md' | 'sm';
}>();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
  (e: 'change', value: T): void;
  (e: 'open'): void;
  (e: 'close'): void;
}>();

const isOpen = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');

// 默认值（不使用 withDefaults，避免泛型组件下的类型推断问题）
const panelAlign = computed<'left' | 'right'>(() => props.align ?? 'left');
const triggerExtraClass = computed(() => props.triggerClass ?? '');
const isSmall = computed(() => props.size === 'sm');
const labelSizeClass = computed(() => (isSmall.value ? 'text-xs' : 'text-xs'));
const iconSizeClass = computed(() => (isSmall.value ? 'w-2.5 h-2.5' : 'w-3 h-3'));
/**
 * 是否显示顶部搜索框。
 *
 * <p>注意：Vue 会把「未传的 Boolean prop」cast 成 {@code false}，所以这里不能用
 * {@code !== false} 判默认开启（那样永远不渲染），必须显式传 {@code true} 才开。</p>
 */
const isSearchable = computed(() => props.searchable === true);

/**
 * 选项与当前值的同一性判定。
 *
 * <p>统一按字符串比较：后端下发的主键 id 多为字符串（如 {@code session.teamId = "5"}），
 * 而本地选项值可能是数字（如 {@code TeamVO.id = 5}），严格 `===` 会把同一个 id 判不等，
 * 表现为「值其实还在，但下拉框回落成 placeholder」。</p>
 */
const toKey = (value: T | null | undefined): string => (value === null || value === undefined ? '' : String(value));
const isSelected = (option: SelectOption<T>): boolean => toKey(option.value) === toKey(props.modelValue);

const selectedOption = computed<SelectOption<T> | null>(
  () => props.options.find(isSelected) ?? null
);
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? t('common.pleaseSelect'));

// 实时搜索过滤
const filteredOptions = computed(() => {
  if (!isSearchable.value || !searchQuery.value.trim()) return props.options;
  const q = searchQuery.value.trim().toLowerCase();
  return props.options.filter(o =>
    String(o.label).toLowerCase().includes(q) ||
    (o.description && String(o.description).toLowerCase().includes(q))
  );
});

interface OptionGroup<T extends string | number> {
  key: string;
  name: string;
  icon?: string;
  count: number;
  options: SelectOption<T>[];
}

/**
 * 按 {@link SelectOption.group} 聚成组，保持选项原始出现顺序。
 *
 * <p>没有 group 的选项归入无名组（不渲染标题），因此既有调用方的渲染结果不变。
 * 数量徽标取组内首个显式 {@code groupCount}，否则用当前可见选项数（搜索后即匹配数）。</p>
 */
const groupedOptions = computed<OptionGroup<T>[]>(() => {
  const groups: OptionGroup<T>[] = [];
  const index = new Map<string, OptionGroup<T>>();
  for (const option of filteredOptions.value) {
    const name = (option.group ?? '').trim();
    let group = index.get(name);
    if (!group) {
      group = { key: name, name, icon: option.groupIcon, count: 0, options: [] };
      index.set(name, group);
      groups.push(group);
    }
    group.options.push(option);
    group.count += 1;
    if (group.options.length === 1 && typeof option.groupCount === 'number') {
      group.count = option.groupCount;
    }
  }
  return groups;
});

/**
 * 分组展开状态：key = 组名。
 *
 * <p>只记录「手动展开过的组」，默认全部收起 —— 提供商多时一屏先看清单，再按需展开。
 * 搜索时一律展开，否则用户搜到了模型却因为组折叠看不到结果，会误以为「没有匹配」。</p>
 */
const expandedGroups = ref<Set<string>>(new Set());

const isGroupCollapsed = (group: OptionGroup<T>): boolean => {
  if (!group.name || searchQuery.value.trim()) return false;
  return !expandedGroups.value.has(group.name);
};

const toggleGroup = (group: OptionGroup<T>) => {
  if (!group.name) return;
  const next = new Set(expandedGroups.value);
  if (next.has(group.name)) next.delete(group.name);
  else next.add(group.name);
  expandedGroups.value = next;
};

// 面板移到 body，避免输入框的隔离层和祖先裁剪遮挡菜单。
/** 面板尺寸上限：更窄更高，长模型名靠截断收口，不撑破面板。 */
const PANEL_MAX_HEIGHT = 384;
const PANEL_MAX_WIDTH = 224;
const PANEL_MIN_WIDTH = 168;

const updatePosition = () => {
  if (!isOpen.value || !rootRef.value || !panelRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  const margin = 8;
  const gap = 10;
  const available = window.innerWidth - margin * 2;
  // 触发器比面板更宽时（表单里的整行选择器）让面板跟着同宽，避免「宽输入框 + 窄下拉」的错位。
  const minWidth = Math.min(Math.max(PANEL_MIN_WIDTH, rect.width), available);
  const width = Math.min(Math.max(panelRef.value.offsetWidth, minWidth), available);
  const left = panelAlign.value === 'left' ? rect.left : rect.right - width;
  const above = Math.max(0, rect.top - gap - margin);
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
  const upward = above >= PANEL_MAX_HEIGHT || above >= below;
  panelStyle.value = {
    left: `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`,
    ...(upward ? { bottom: `${window.innerHeight - rect.top + gap}px` } : { top: `${rect.bottom + gap}px` }),
    maxHeight: `${Math.min(PANEL_MAX_HEIGHT, upward ? above : below)}px`,
    // 内联样式优先级高于 class：这里必须同步收紧，否则 max-w-[14rem] 会被顶掉。
    maxWidth: `${Math.min(PANEL_MAX_WIDTH, available)}px`,
    minWidth: `${minWidth}px`,
  };
};

const open = () => {
  if (props.disabled) return;
  isOpen.value = true;
  searchQuery.value = '';
  emit('open');
  nextTick(() => {
    updatePosition();
    if (isSearchable.value) searchInputRef.value?.focus();
  });
};

const close = () => {
  if (!isOpen.value) return;
  isOpen.value = false;
  searchQuery.value = '';
  emit('close');
};

const toggle = () => {
  isOpen.value ? close() : open();
};

const select = (option: SelectOption<T>) => {
  if (option.disabled) return;
  if (!isSelected(option)) {
    emit('update:modelValue', option.value);
    emit('change', option.value);
  }
  close();
};

const handleSearchEnter = () => {
  if (filteredOptions.value.length > 0) {
    const matched = filteredOptions.value.find(o => !o.disabled);
    if (matched) select(matched);
  }
};

const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as Node;
  if (!rootRef.value?.contains(target) && !panelRef.value?.contains(target)) close();
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') close();
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});

defineExpose({
  open,
  close
});
</script>

<template>
  <div ref="rootRef" class="relative inline-flex items-center">
    <!-- 触发器：包含 svg 的小方块 -->
    <button
      type="button"
      :disabled="disabled"
      class="flex items-center justify-between gap-1.5 rounded-lg transition outline-none"
      :class="[
        !triggerExtraClass ? (isSmall ? 'h-8 px-2.5 py-1.5' : 'h-9 px-3 py-2') : '',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        // 边框颜色随主题：调用方只写 `border` 宽度时，Tailwind 默认用 currentColor 会画出深色粗边。
        // [Q2] border-white/20 : border-gray-300 → border-strong（equalDark/equalLight 均 true）
        'border-lx-border-strong',
        isDark ? 'hover:bg-white/5' : 'hover:bg-black/5',
        triggerExtraClass
      ]"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <slot name="trigger" :is-open="isOpen" :selected="selectedOption" :label="displayLabel">
        <span
          class="font-medium leading-[18px] truncate max-w-[150px]"
          :class="[labelSizeClass, 'text-lx-tertiary']"
        >{{ displayLabel }}</span>
        <!-- chevron svg：上拉展开时旋转 180° -->
        <svg
          class="shrink-0 origin-center transition-transform duration-300 ease-out"
          :class="[iconSizeClass, isOpen ? 'rotate-180' : 'rotate-0']"
          viewBox="0 0 1024 1024"
          version="1.1"
          xmlns="http://www.w3.org/2000/svg"
          :fill="isDark ? '#9ca3af' : '#6b7280'"
        >
          <path d="M838.116 732.779 877.7 693.195 511.979 327.549 146.3 693.195 185.883 732.779 512.003 406.652Z" />
        </svg>
      </slot>
    </button>

    <!-- 上拉面板 (对齐 media_1789910619342.png 视觉规范) -->
    <Teleport to="body">
    <transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-1 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-1 scale-95"
    >
      <div
        v-if="isOpen"
        ref="panelRef"
        :style="panelStyle"
        role="listbox"
        class="fixed min-w-[10.5rem] max-w-[14rem] max-h-96 overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-1.5 z-[1000] backdrop-blur-2xl"
        :class="[
          isDark ? 'dark' : 'light',
          isDark
            ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.95)]'
            : 'bg-white border-zinc-200/90 text-gray-800 shadow-[0_12px_30px_rgba(0,0,0,0.12)]'
        ]"
      >
        <!-- 顶部搜索框 (完全对齐 media_1789910619342.png: 搜索...) -->
        <div v-if="isSearchable" class="px-1.5 pt-1 pb-1.5 shrink-0">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="searchPlaceholder ?? t('common.searchPlaceholder')"
            class="w-full px-2 py-1 text-xs border rounded-lg outline-none select-text transition"
            :class="isDark ? 'bg-white/[0.06] border-lx-border text-white placeholder-lx-faint focus:border-cyan-400/60' : 'bg-transparent border-lx-border text-gray-800 placeholder-lx-faint focus:border-blue-500'"
            @keydown.stop
            @keydown.esc="close"
            @keydown.enter="handleSearchEnter"
          />
        </div>

        <div
          v-if="menuTitle"
          class="px-2.5 py-1 font-semibold uppercase tracking-wider text-[10px]"
          :class="'text-lx-faint'"
        >
          {{ menuTitle }}
        </div>

        <!-- 选项列表可滚动区 -->
        <div class="min-h-0 overflow-y-auto scrollbar-thin space-y-0.5 max-h-80">
          <div
            v-if="filteredOptions.length === 0"
            class="px-3 py-2 text-xs text-lx-faint text-center"
          >
            {{ t('common.noOptions') }}
          </div>

          <template v-for="(group, groupIdx) in groupedOptions" :key="group.key || `__ungrouped_${groupIdx}`">
            <!-- 组标题：图标 + 名称 + 数量徽标 + 折叠箭头（未设置 group 的选项不渲染） -->
            <button
              v-if="group.name"
              type="button"
              :aria-expanded="!isGroupCollapsed(group)"
              :title="isGroupCollapsed(group) ? t('common.expand') : t('common.collapse')"
              class="w-full px-2.5 pt-1.5 pb-0.5 flex items-center gap-1.5 select-none cursor-pointer rounded-lg bg-transparent border-0 text-left transition-colors"
              :class="isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'"
              @click.stop="toggleGroup(group)"
            >
              <ProviderIcon
                v-if="group.icon"
                :icon="group.icon"
                :name="group.name"
                :size="12"
              />
              <span
                class="flex-1 min-w-0 text-[10px] font-bold uppercase tracking-wider truncate text-lx-secondary"
              >{{ group.name }}</span>
              <span
                class="shrink-0 px-1.5 py-px rounded-md text-[10px] leading-none bg-lx-surface-selected text-lx-muted"
              >{{ group.count }}</span>
              <!-- 折叠箭头：收起朝右（可展开），展开朝下（内容已铺开） -->
              <svg
                class="w-2.5 h-2.5 shrink-0 transition-transform duration-200"
                :class="[
                  isGroupCollapsed(group) ? 'rotate-90' : 'rotate-180',
                  'text-lx-faint'
                ]"
                viewBox="0 0 1024 1024"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M838.116 732.779 877.7 693.195 511.979 327.549 146.3 693.195 185.883 732.779 512.003 406.652Z" />
              </svg>
            </button>

            <template v-if="!isGroupCollapsed(group)">
              <template v-for="(option, idx) in group.options" :key="option.value">
                <!-- 针对 '+ 添加团队' 等操作项的分隔线 -->
                <div
                  v-if="String(option.value).startsWith('__add_') && idx > 0"
                  class="h-px my-1 bg-zinc-100 dark:bg-gray-800/80"
                ></div>

                <div
                  role="option"
                  :aria-selected="isSelected(option)"
                  :class="[
                    'px-3 py-2 rounded-xl text-xs flex items-center gap-2 transition-colors select-none',
                    option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                    isSelected(option)
                      ? (isDark ? 'border border-white/85 bg-white/[0.12] text-white font-medium shadow-[0_0_14px_rgba(255,255,255,0.22)]' : 'bg-zinc-100 text-gray-900 font-normal')
                      : (!option.disabled ? (isDark ? 'hover:bg-white/10 text-zinc-300' : 'hover:bg-zinc-50 text-zinc-700') : '')
                  ]"
                  @click="select(option)"
                >
                <!-- 内置提供商图标走 SVG，其余仍按 URL / Emoji 渲染 -->
                <ProviderIcon
                  v-if="option.avatar && isBuiltInProviderIcon(option.avatar)"
                  :icon="option.avatar"
                  :name="option.label"
                  :size="16"
                />
                <!-- 头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
                <img
                  v-else-if="option.avatar && isImageAvatar(option.avatar)"
                  :src="option.avatar"
                  :alt="option.label"
                  class="w-4 h-4 rounded-full object-cover shrink-0"
                />
                <span
                  v-else-if="option.avatar"
                  class="shrink-0 text-xs leading-none select-none"
                >{{ option.avatar }}</span>
                <!-- flex-1 + min-w-0 + truncate：长模型名截断，绝不撑破面板宽度 -->
                <span class="flex-1 min-w-0 truncate text-left font-normal leading-[18px]">{{ option.label }}</span>
                <!-- 对勾图标 (完全对齐 media_1789910619342.png 右侧 checkmark) -->
                <svg
                  v-if="isSelected(option)"
                  class="w-4 h-4 shrink-0 ml-auto"
                  :class="isDark ? 'text-white' : 'text-gray-900'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              </template>
            </template>
          </template>
        </div>
      </div>
    </transition>
    </Teleport>
  </div>
</template>
