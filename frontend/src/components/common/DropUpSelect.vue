<script setup lang="ts" generic="T extends string | number">
/**
 * 上拉选择器（预设薄壳）。
 *
 * <p>行为全部来自 {@link LxSelect}（开合 / 定位 / 键盘 / aria / Teleport / 过渡 / 搜索 / 分组），
 * 这里只保留「上拉浮层」这套外观与历史 API：泛型 value、搜索、分组折叠、头像渲染、
 * `trigger` 插槽（props 名保持 `isOpen` / `selected` / `label`，存量调用方零改动）。</p>
 */
import { computed, ref } from 'vue';
import LxSelect from './LxSelect.vue';
import ProviderIcon from '../model/ProviderIcon.vue';
import type { SelectOption } from '../../types/ui';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import { isImageAvatar } from '../../utils/avatar';
import { isBuiltInProviderIcon } from '../../utils/providerIcons';

defineOptions({ inheritAttrs: false });

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
  /** 是否开启顶部实时搜索输入框，默认关闭（Boolean prop 缺省会 cast 成 false） */
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

const { isDark: themeIsDark } = useTheme();
/** 缺省 Boolean prop 会被 cast 成 false，不能写 `?? ` 兜底。 */
const isDark = computed(() => (props.isDark === undefined ? themeIsDark.value : props.isDark));
const isSmall = computed(() => props.size === 'sm');
const labelSizeClass = computed(() => 'text-xs');
const iconSizeClass = computed(() => (isSmall.value ? 'w-2.5 h-2.5' : 'w-3 h-3'));
const displayPlaceholder = computed(() => props.placeholder ?? t('common.pleaseSelect'));

const selectRef = ref<{ open: () => Promise<void>; close: () => void } | null>(null);
defineExpose({
  open: () => selectRef.value?.open(),
  close: () => selectRef.value?.close(),
});
</script>

<template>
  <LxSelect
    ref="selectRef"
    v-bind="$attrs"
    variant="popup"
    :model-value="modelValue"
    :options="options"
    :is-dark="isDark"
    :size="size"
    :align="align"
    :searchable="searchable === true"
    :search-placeholder="searchPlaceholder"
    :menu-title="menuTitle"
    :trigger-class="triggerClass"
    :placeholder="displayPlaceholder"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
    @open="emit('open')"
    @close="emit('close')"
  >
    <template #trigger="{ isOpen: menuOpen, selected, label }">
      <slot name="trigger" :is-open="menuOpen" :selected="selected" :label="label">
        <span
          class="font-medium leading-[18px] truncate max-w-[150px]"
          :class="[labelSizeClass, 'text-lx-tertiary']"
        >{{ label }}</span>
        <!-- chevron svg：展开时旋转 180° -->
        <svg
          class="shrink-0 origin-center transition-transform duration-300 ease-out"
          :class="[iconSizeClass, menuOpen ? 'rotate-180' : 'rotate-0']"
          viewBox="0 0 1024 1024"
          version="1.1"
          xmlns="http://www.w3.org/2000/svg"
          :fill="isDark ? '#9ca3af' : '#6b7280'"
          aria-hidden="true"
        >
          <path d="M838.116 732.779 877.7 693.195 511.979 327.549 146.3 693.195 185.883 732.779 512.003 406.652Z" />
        </svg>
      </slot>
    </template>

    <!-- 选项内容归壳：上拉浮层要头像 + 名称 + 选中对钩 -->
    <template #option="{ option, selected }">
      <!-- 内置提供商图标走 SVG，其余按 URL / Emoji 渲染 -->
      <ProviderIcon
        v-if="option.avatar && isBuiltInProviderIcon(option.avatar)"
        :icon="option.avatar"
        :name="option.label"
        :size="16"
      />
      <img
        v-else-if="option.avatar && isImageAvatar(option.avatar)"
        :src="option.avatar"
        :alt="option.label"
        class="w-4 h-4 rounded-full object-cover shrink-0"
      />
      <span v-else-if="option.avatar" class="shrink-0 text-xs leading-none select-none">{{ option.avatar }}</span>
      <!-- flex-1 + min-w-0 + truncate：长模型名截断，绝不撑破面板宽度 -->
      <span class="flex-1 min-w-0 truncate text-left font-normal leading-[18px]">{{ option.label }}</span>
      <svg
        v-if="selected"
        class="w-4 h-4 shrink-0 ml-auto"
        :class="isDark ? 'text-white' : 'text-zinc-900'"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
    </template>
  </LxSelect>
</template>
