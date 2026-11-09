<script setup lang="ts">
/**
 * 设置页下拉（预设薄壳）。
 *
 * <p>行为全部来自 {@link LxSelect}（开合 / 定位 / 键盘 / aria / Teleport / 过渡），
 * 这里只保留设置页的**外观约定**与历史 API（`id` + `label` 必填、选项用 `desc` 而不是
 * `description`、value 固定 string），所以存量调用方零改动。</p>
 */
import { computed } from 'vue';
import LxSelect from './LxSelect.vue';
import type { SelectOption } from '../../types/ui';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  id: string;
  label: string;
  modelValue: string;
  options: { value: string; label: string; desc?: string }[];
  disabled?: boolean;
  /** 无匹配选项（如必填项尚未选择）时的占位文案，缺省为空 = 保持旧行为。 */
  placeholder?: string;
}>();
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();

const lxOptions = computed<SelectOption<string>[]>(() => props.options.map(option => ({
  value: option.value,
  label: option.label,
  description: option.desc,
})));
</script>

<template>
  <LxSelect
    v-bind="$attrs"
    :id="id"
    :label="label"
    variant="settings"
    :model-value="modelValue"
    :options="lxOptions"
    :disabled="disabled"
    :placeholder="placeholder"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 触发器内容可被调用方接管（外观由 LxSelect 的 settings 预设保证一致，这里只管内容） -->
    <template v-if="$slots.trigger" #trigger="slotProps">
      <slot name="trigger" v-bind="slotProps" />
    </template>

    <!-- 选项内容归壳：设置页默认「名称 + 描述两行 + 选中对钩」，调用方可覆盖 -->
    <template #option="slotProps">
      <slot name="option" v-bind="slotProps">
        <span class="flex min-w-0 flex-col">
          <span :class="slotProps.option.description ? 'leading-snug' : 'truncate'">{{ slotProps.option.label }}</span>
          <!-- 有 description 的选项必须把取舍一并渲染出来，否则用户只看到档位名 -->
          <span v-if="slotProps.option.description" class="settings-select-option-desc">{{ slotProps.option.description }}</span>
        </span>
        <svg v-if="slotProps.selected" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m5 12 4 4L19 6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </slot>
    </template>
  </LxSelect>
</template>

<style scoped>
@reference "../../style.css";

/*
 * 插槽内容属于壳的渲染域，作用域 CSS 只认壳，所以描述样式必须放在这里
 * （写在 LxSelect 里对插槽内容不生效）。
 */
.settings-select-option-desc {
  @apply mt-0.5 line-clamp-2 text-lx-fs-sm font-normal leading-snug text-lx-faint;
}
</style>
