<script setup lang="ts">
/**
 * 模型选择器默认实现（原 `ChatInputArea.vue` 1575–1632 整段，逐字搬家）。
 *
 * <p>两个生产态由**组件**决定（`drivenModel` 非空 = Agent/团队驱动，选择器不参与本轮，
 * 走徽标态；否则选择器即权威，走 DropUpSelect），消费者只拿到 `drivenModel` 的只读投影：
 * 状态与来源的判定口径留在原组件，替换实现不可能"自己算一份"。</p>
 *
 * <p>`+ 添加自定义模型` 用的是本地哨兵值，专门路由到 `onOpenModelEditor`，不会带着哨兵值
 * 去调 `onUpdateModel`（否则后端会收到一个不存在的 model id）。</p>
 */
import { computed } from 'vue';
import DropUpSelect from '../common/DropUpSelect.vue';
import ProviderIcon from '../model/ProviderIcon.vue';
import type { SelectOption } from '../../types/ui';
import { t } from '../../i18n';
import type { ChatInputModelSelectorSlotProps } from '../../types/chatInputSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatInputModelSelectorSlotProps>();

// 基座模型：按提供商分组展示（同一模型名可能来自不同提供商），选中值仍是 model id。
const ADD_CUSTOM_MODEL = '__add_custom_model__';
const modelOptions = computed<SelectOption<string | number>[]>(() => {
  const ungroupedLabel = t('chat.input.ungroupedProvider');
  const options: SelectOption<string | number>[] = props.models.map(m => ({
    label: m.name || m.modelName || t('session.modelFallback', { id: m.id }),
    value: m.id,
    group: m.providerName || ungroupedLabel,
    // 图标只挂在组标题上：同一提供商下的模型重复渲染 logo 只会挤占名称宽度。
    groupIcon: m.providerIcon ?? undefined,
  }));
  // 不给 group：「+ 添加自定义模型」落在末尾的无名块，不会混进上面任一提供商组。
  options.push({ label: t('chat.input.addCustomModel'), value: ADD_CUSTOM_MODEL });
  return options;
});
const selectedModel = computed<string | number>({
  get: () => props.selectedModelId ?? '',
  set: (value) => { if (value === ADD_CUSTOM_MODEL) { props.onOpenModelEditor(); return; } props.onUpdateModel(value); }
});
</script>

<template>
  <!-- 模型：Agent/团队预设驱动时选择器不参与本轮，改显实际生效模型与来源（点击去改预设） -->
  <button
    v-if="props.drivenModel"
    data-slot="model-selector"
    type="button"
    class="inline-flex h-7 max-w-[230px] flex-none cursor-pointer items-center gap-1 rounded-lg border px-2 text-[12px] font-medium whitespace-nowrap transition"
    :class="props.drivenModel.missing
      ? (props.isDark
        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
        : 'border-amber-300 bg-amber-50 text-amber-700')
      : (props.isDark
        ? 'border-white/15 text-zinc-300 hover:bg-white/10 hover:text-zinc-100'
        : 'border-gray-200 text-gray-600 hover:bg-black/5 hover:text-gray-900')"
    :title="props.drivenModel.tip"
    :aria-label="props.drivenModel.tip"
    @mousedown.prevent
    @click="props.onOpenSettingsTab('agents')"
  >
    <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path stroke-linecap="round" d="M8 11V8a4 4 0 018 0v3" />
    </svg>
    <span class="truncate">{{ props.drivenModel.text }}</span>
  </button>

  <!-- 模型选择下拉（无 Agent/团队驱动时，选择器即权威） -->
  <DropUpSelect
    v-else
    v-model="selectedModel"
    data-slot="model-selector"
    :options="modelOptions"
    :isDark="props.isDark"
    size="sm"
    :searchable="true"
    :placeholder="t('chat.input.selectModel')"
    trigger-class="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] hover:[color:var(--pb-ink)] whitespace-nowrap"
  >
    <template #trigger="{ selected, isOpen: menuOpen }">
      <ProviderIcon
        v-if="selected?.groupIcon"
        :icon="selected.groupIcon"
        :name="selected.group ?? selected.label"
        :size="14"
      />
      <span class="truncate max-w-[220px] text-[12px] leading-[18px]">
        <template v-if="selected?.group">{{ selected.group }} / </template>{{ selected?.label ?? t('chat.input.selectModel') }}
      </span>
      <svg
        class="w-2.5 h-2.5 shrink-0 origin-center transition-transform duration-300 ease-out"
        :class="menuOpen ? 'rotate-180' : 'rotate-0'"
        viewBox="0 0 1024 1024"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M838.116 732.779 877.7 693.195 511.979 327.549 146.3 693.195 185.883 732.779 512.003 406.652Z" />
      </svg>
    </template>
  </DropUpSelect>
</template>
