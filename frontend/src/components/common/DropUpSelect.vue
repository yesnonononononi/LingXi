<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SelectOption } from '../../types/ui';

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

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
  (e: 'change', value: T): void;
  (e: 'open'): void;
  (e: 'close'): void;
}>();

const isOpen = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');

// 默认值（不使用 withDefaults，避免泛型组件下的类型推断问题）
const panelAlign = computed<'left' | 'right'>(() => props.align ?? 'left');
const triggerExtraClass = computed(() => props.triggerClass ?? '');
const isSmall = computed(() => props.size === 'sm');
const labelSizeClass = computed(() => (isSmall.value ? 'text-xs' : 'text-xs'));
const iconSizeClass = computed(() => (isSmall.value ? 'w-2.5 h-2.5' : 'w-3 h-3'));
const isSearchable = computed(() => props.searchable !== false);

const selectedOption = computed<SelectOption<T> | null>(
  () => props.options.find(o => o.value === props.modelValue) ?? null
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

const open = () => {
  if (props.disabled) return;
  isOpen.value = true;
  searchQuery.value = '';
  emit('open');
  if (isSearchable.value) {
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  }
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
  if (option.value !== props.modelValue) {
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
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) close();
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') close();
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
});

defineExpose({
  open,
  close
});
</script>

<template>
  <div ref="rootRef" class="relative inline-block">
    <!-- 触发器：包含 svg 的小方块 -->
    <button
      type="button"
      :disabled="disabled"
      class="flex items-center justify-center gap-1.5 rounded-lg transition outline-none"
      :class="[
        isSmall ? 'h-8 px-2.5 py-1.5' : 'h-9 px-3 py-2',
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
          class="font-medium leading-normal py-0.5 truncate max-w-[150px]"
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
        role="listbox"
        class="absolute bottom-full mb-2.5 min-w-[11.5rem] max-w-[16rem] max-h-72 overflow-hidden flex flex-col rounded-2xl border shadow-xl p-1.5 z-50 backdrop-blur-md"
        :class="[
          panelAlign === 'left' ? 'left-0' : 'right-0',
          isDark
            ? 'bg-[#161b26]/95 border-[#273043] text-gray-200 shadow-[0_12px_30px_rgba(0,0,0,0.5)]'
            : 'bg-white border-gray-200/90 text-gray-800 shadow-[0_12px_30px_rgba(0,0,0,0.12)]'
        ]"
      >
        <!-- 顶部搜索框 (完全对齐 media_1789910619342.png: 搜索...) -->
        <div v-if="isSearchable" class="px-2 pt-1 pb-1.5 shrink-0">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="searchPlaceholder ?? '搜索...'"
            class="w-full px-1 py-0.5 text-xs bg-transparent border-none outline-none focus:outline-none focus:ring-0 select-text"
            :class="isDark ? 'text-gray-100 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'"
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
        <div class="overflow-y-auto scrollbar-thin space-y-0.5 max-h-56">
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
              :aria-selected="option.value === modelValue"
              :class="[
                'px-3 py-2 rounded-xl text-xs flex items-center justify-between transition-colors select-none',
                option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                option.value === modelValue
                  ? (isDark ? 'bg-white/10 text-white font-normal' : 'bg-gray-100 text-gray-900 font-normal')
                  : (!option.disabled ? (isDark ? 'hover:bg-white/5 text-gray-300' : 'hover:bg-gray-50 text-gray-700') : '')
              ]"
              @click="select(option)"
            >
              <span class="truncate pr-2 font-normal leading-normal py-0.5">{{ option.label }}</span>
              <!-- 对勾图标 (完全对齐 media_1789910619342.png 右侧 checkmark) -->
              <svg
                v-if="option.value === modelValue"
                class="w-4 h-4 shrink-0"
                :class="isDark ? 'text-gray-200' : 'text-gray-900'"
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
  </div>
</template>
