<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SelectOption } from '../../types/ui';
import { useTheme } from '../../composables/useTheme';

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
const isSearchable = computed(() => props.searchable !== false);

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
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? '请选择');

// 实时搜索过滤
const filteredOptions = computed(() => {
  if (!isSearchable.value || !searchQuery.value.trim()) return props.options;
  const q = searchQuery.value.trim().toLowerCase();
  return props.options.filter(o =>
    String(o.label).toLowerCase().includes(q) ||
    (o.description && String(o.description).toLowerCase().includes(q))
  );
});

// 面板移到 body，避免输入框的隔离层和祖先裁剪遮挡菜单。
const updatePosition = () => {
  if (!isOpen.value || !rootRef.value || !panelRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  const margin = 8;
  const gap = 10;
  const width = Math.min(panelRef.value.offsetWidth, window.innerWidth - margin * 2);
  const left = panelAlign.value === 'left' ? rect.left : rect.right - width;
  const above = Math.max(0, rect.top - gap - margin);
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
  const upward = above >= 288 || above >= below;
  panelStyle.value = {
    left: `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`,
    ...(upward ? { bottom: `${window.innerHeight - rect.top + gap}px` } : { top: `${rect.bottom + gap}px` }),
    maxHeight: `${Math.min(288, upward ? above : below)}px`,
    maxWidth: `${window.innerWidth - margin * 2}px`,
    minWidth: `${Math.min(184, window.innerWidth - margin * 2)}px`,
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
      class="flex items-center justify-center gap-1.5 rounded-lg transition outline-none"
      :class="[
        !triggerExtraClass ? (isSmall ? 'h-8 px-2.5 py-1.5' : 'h-9 px-3 py-2') : '',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        isDark ? 'hover:bg-white/5' : 'hover:bg-black/5',
        triggerExtraClass
      ]"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <slot name="trigger" :is-open="isOpen" :selected="selectedOption" :label="displayLabel">
        <span
          class="font-medium leading-none truncate max-w-[150px]"
          :class="[labelSizeClass, isDark ? 'text-gray-300' : 'text-gray-600']"
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
        class="fixed min-w-[11.5rem] max-w-[16rem] max-h-72 overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-1.5 z-[1000] backdrop-blur-2xl"
        :class="[
          isDark ? 'dark' : 'light',
          isDark
            ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.95)]'
            : 'bg-white border-gray-200/90 text-gray-800 shadow-[0_12px_30px_rgba(0,0,0,0.12)]'
        ]"
      >
        <!-- 顶部搜索框 (完全对齐 media_1789910619342.png: 搜索...) -->
        <div v-if="isSearchable" class="px-1.5 pt-1 pb-1.5 shrink-0">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="searchPlaceholder ?? '搜索...'"
            class="w-full px-2 py-1 text-xs border rounded-lg outline-none select-text transition"
            :class="isDark ? 'bg-white/[0.06] border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/60' : 'bg-transparent border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'"
            @keydown.stop
            @keydown.esc="close"
            @keydown.enter="handleSearchEnter"
          />
        </div>

        <div
          v-if="menuTitle"
          class="px-2.5 py-1 font-semibold uppercase tracking-wider text-[10px]"
          :class="isDark ? 'text-gray-500' : 'text-gray-400'"
        >
          {{ menuTitle }}
        </div>

        <!-- 选项列表可滚动区 -->
        <div class="min-h-0 overflow-y-auto scrollbar-thin space-y-0.5 max-h-56">
          <div
            v-if="filteredOptions.length === 0"
            class="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 text-center"
          >
            无匹配选项
          </div>

          <template v-for="(option, idx) in filteredOptions" :key="option.value">
            <!-- 针对 '+ 添加团队' 等操作项的分隔线 -->
            <div
              v-if="String(option.value).startsWith('__add_') && idx > 0"
              class="h-px my-1 bg-gray-100 dark:bg-gray-800/80"
            ></div>

            <div
              role="option"
              :aria-selected="isSelected(option)"
              :class="[
                'px-3 py-2 rounded-xl text-xs flex items-center justify-between transition-colors select-none',
                option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                isSelected(option)
                  ? (isDark ? 'bg-cyan-500/15 text-cyan-300 font-medium border border-cyan-500/30' : 'bg-gray-100 text-gray-900 font-normal')
                  : (!option.disabled ? (isDark ? 'hover:bg-white/10 text-zinc-300' : 'hover:bg-gray-50 text-gray-700') : '')
              ]"
              @click="select(option)"
            >
              <span class="truncate pr-2 font-normal leading-normal py-0.5">{{ option.label }}</span>
              <!-- 对勾图标 (完全对齐 media_1789910619342.png 右侧 checkmark) -->
              <svg
                v-if="isSelected(option)"
                class="w-4 h-4 shrink-0"
                :class="isDark ? 'text-cyan-400' : 'text-gray-900'"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </template>
        </div>
      </div>
    </transition>
    </Teleport>
  </div>
</template>
