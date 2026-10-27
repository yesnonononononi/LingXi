<script setup lang="ts">
import { computed } from 'vue';
import { useModelsTab } from './useModelsTab';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';
import ModelVisionField from '../../../components/model/ModelVisionField.vue';
import ProviderIcon from '../../../components/model/ProviderIcon.vue';
import DropUpSelect from '../../../components/common/DropUpSelect.vue';
import type { SelectOption } from '../../../types/ui';
import BatchModelsForm from './BatchModelsForm.vue';
import { useModelImportCopy } from './useModelImportCopy';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const importCopy = useModelImportCopy();
const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

const emit = defineEmits<{
  (e: 'modelUpdated'): void;
}>();

const {
  catalogGroups,
  providers,
  isModelLoading,
  modelErrorMsg,
  mode,
  isSubmitting,
  showApiKey,
  modelToast,
  providerForm,
  providerFormError,
  batchProvider,
  batchExistingNames,
  startBatchModels,
  refreshAfterChange,
  modelForm,
  modelFormError,
  isFetchingRemoteModels,
  isRemoteModelDropdownOpen,
  remoteModelSearch,
  fetchRemoteModelError,
  filteredRemoteModels,
  loadAll,
  startAddProvider,
  startEditProvider,
  saveProviderForm,
  deleteProvider,
  startAddModel,
  startEditModel,
  handleProviderChange,
  providerHasCredential,
  cancelForm,
  saveModelForm,
  handleDeleteModel,
  handleFetchRemoteModels,
  handleSelectRemoteModel,
} = useModelsTab(() => emit('modelUpdated'));

const ungroupedLabel = computed(() => t('settings.models.ungrouped'));

/** 模型表单的提供方下拉：空归属显示为「未分组」(0)，后端据此解除归属。 */
const providerOptions = computed<SelectOption<string | number>[]>(() => [
  ...providers.value.map(provider => ({
    label: provider.name,
    value: provider.id,
    avatar: provider.icon ?? undefined,
  })),
  { label: ungroupedLabel.value, value: 0 },
]);

const selectedProviderValue = computed<string | number>({
  get: () => modelForm.value.providerConfigId ?? 0,
  set: (value) => handleProviderChange(value),
});

const groupTitle = (name?: string | null) => name?.trim() || ungroupedLabel.value;

/**
 * 聚合分组里没有密钥与排序字段，编辑要走完整 provider 记录；
 * 找不到（悬空引用/未分组）就不提供编辑入口。
 */
const editProviderOfGroup = (providerConfigId?: string | number | null) => {
  if (providerConfigId === null || providerConfigId === undefined) return;
  const provider = providers.value.find(item => String(item.id) === String(providerConfigId));
  if (provider) startEditProvider(provider);
};

const fieldClass = computed(() => [
  'w-full px-3 py-2 rounded-xl text-xs border outline-none transition',
  isDark.value
    ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400'
    : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-blue-500 shadow-2xs',
]);
const labelClass = computed(() => [
  'block text-xs font-medium mb-1',
  isDark.value ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700',
]);
const cardClass = computed(() => [
  'rounded-2xl border transition-colors',
  isDark.value
    ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
    : 'bg-zinc-50/70 border-gray-200 hover:border-gray-300',
]);
const ghostBtnClass = computed(() => [
  'px-3 py-1 rounded-lg border text-xs font-medium transition cursor-pointer',
  isDark.value
    ? 'border-white/20 hover:border-white/40 bg-white/[0.06] hover:bg-white/[0.12] text-zinc-100'
    : 'border-gray-200 hover:bg-zinc-50 text-gray-700',
]);
const dangerBtnClass = computed(() => [
  'text-xs px-2 py-1 transition cursor-pointer font-medium',
  isDark.value ? 'text-rose-400 hover:text-rose-300' : 'text-red-500 hover:text-red-600',
]);
const addRowClass = computed(() => [
  'w-full py-2 text-[11px] rounded-xl flex items-center justify-center gap-1 transition cursor-pointer',
  isDark.value
    ? 'text-zinc-300 hover:text-white hover:bg-white/[0.06]'
    : 'text-gray-500 hover:text-gray-800 hover:bg-zinc-100/70',
]);
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="modelToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ modelToast }}</span>
    </div>

    <!-- ============================== 列表 ============================== -->
    <div v-if="mode === 'list'" class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h4 class="text-base font-bold tracking-tight" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
            {{ t('settings.models.title') }}
          </h4>
          <p class="text-xs mt-1" :class="isDark ? 'text-zinc-400 text-glow-subtle' : 'text-gray-500'">
            {{ t('settings.models.subtitle') }}
          </p>
        </div>
        <button
          type="button"
          @click="startAddProvider()"
          class="shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium text-white transition cursor-pointer"
          :class="isDark ? 'bg-sky-600 hover:bg-sky-500' : 'bg-blue-600 hover:bg-blue-500 shadow-sm'"
        >
          {{ t('settings.models.addProvider') }}
        </button>
      </div>

      <div v-if="isModelLoading" class="py-8 text-center text-xs text-lx-faint">
        {{ t('settings.models.loading') }}
      </div>

      <div v-else-if="modelErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ modelErrorMsg }}</p>
        <button
          type="button"
          @click="loadAll"
          class="px-3 py-1 rounded-lg border border-red-300 dark:border-red-800 text-xs hover:bg-red-500/10 cursor-pointer"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <div v-else class="space-y-3">
        <div
          v-if="catalogGroups.length === 0"
          class="py-12 text-center text-xs border border-dashed rounded-2xl border-lx-border-subtle text-lx-faint"
        >
          {{ t('settings.models.empty') }}
        </div>

        <!-- 提供商卡片：图标 + 名称 + 模型数 + 编辑/删除，下挂模型列表 -->
        <div v-for="(group, groupIndex) in catalogGroups" :key="group.providerConfigId ?? `ungrouped-${groupIndex}`" :class="cardClass">
          <div class="flex items-center justify-between gap-2 px-4 py-3">
            <div class="flex items-center gap-2 min-w-0">
              <ProviderIcon :icon="group.providerIcon" :name="group.providerName" :size="18" />
              <span class="font-semibold text-sm truncate" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
                {{ groupTitle(group.providerName) }}
              </span>
              <span
                class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border tracking-tight"
                :class="isDark ? 'border-white/20 text-zinc-300 bg-white/5' : 'border-gray-200 text-gray-500'"
              >{{ t('settings.models.providerModels', { count: group.modelCount }) }}</span>
            </div>
            <div v-if="group.providerConfigId" class="flex items-center gap-2 shrink-0">
              <button type="button" :class="ghostBtnClass" @click="startBatchModels(group.providerConfigId)">
                {{ importCopy.batch }}
              </button>
              <button type="button" :class="ghostBtnClass" @click="editProviderOfGroup(group.providerConfigId)">
                {{ t('common.edit') }}
              </button>
              <button
                type="button"
                :class="dangerBtnClass"
                @click="deleteProvider({ id: group.providerConfigId, name: groupTitle(group.providerName) })"
              >
                {{ t('common.remove') }}
              </button>
            </div>
          </div>

          <div class="px-2 pb-1">
            <div
              v-for="item in group.models"
              :key="item.id"
              class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl"
              :class="isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-white'"
            >
              <span class="text-xs truncate text-lx-secondary">
                {{ item.modelName || t('settings.models.unnamed') }}
              </span>
              <div class="flex items-center gap-1.5 shrink-0">
                <button type="button" class="text-[11px] px-2 py-0.5 rounded-md transition cursor-pointer text-lx-muted hover:text-lx-primary hover:bg-lx-surface-selected" @click="startEditModel(item)">
                  {{ t('common.edit') }}
                </button>
                <button type="button" class="text-[11px] px-2 py-0.5 rounded-md transition cursor-pointer" :class="isDark ? 'text-rose-400 hover:text-rose-300 hover:bg-rose-500/10' : 'text-red-500 hover:text-red-600 hover:bg-red-50'" @click="handleDeleteModel(item)">
                  {{ t('common.remove') }}
                </button>
              </div>
            </div>

            <div v-if="group.models.length === 0" class="px-2.5 py-1.5 text-[11px] text-lx-faint">
              {{ t('settings.models.emptyGroup') }}
            </div>

            <button type="button" :class="addRowClass" @click="startAddModel(group.providerConfigId ?? null)">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              {{ t('settings.models.addModel') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ========================== 提供商表单 ========================== -->
    <div v-else-if="mode === 'provider-form'" class="space-y-4">
      <div class="flex items-center justify-between pb-1 border-b border-zinc-100 dark:border-gray-800">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cancelForm"
            :title="t('settings.models.backToList')"
            :class="['p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition cursor-pointer', isDark ? 'hover:bg-white/5' : 'hover:bg-black/5']"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h4 class="text-sm font-bold tracking-tight text-lx-primary">
            {{ providerForm.id !== null ? t('settings.models.editProviderHeading') : t('settings.models.addProviderHeading') }}
          </h4>
        </div>
        <span class="text-[11px] text-gray-400">{{ t('settings.models.providerFormSubtitle') }}</span>
      </div>

      <div class="space-y-3">
        <div v-if="providerForm.id === null" class="flex items-center gap-3 text-xs text-gray-400" aria-label="steps">
          <span class="text-blue-600 dark:text-sky-400">1 · {{ importCopy.connection }}</span><span>→</span><span>2 · {{ importCopy.selection }}</span>
        </div>
        <div>
          <label :class="labelClass">{{ t('settings.models.providerNameLabel') }} <span class="text-red-500">*</span></label>
          <input v-model="providerForm.name" data-testid="provider-name" :placeholder="t('settings.models.providerNamePlaceholder')" :class="fieldClass" />
        </div>

        <div>
          <label for="provider-base-url" :class="labelClass">{{ t('settings.models.baseUrlLabel') }} <span class="text-red-500">*</span></label>
          <input id="provider-base-url" v-model="providerForm.baseUrl" :placeholder="t('settings.models.baseUrlPlaceholder')" :class="fieldClass" />
          <p class="mt-1 text-[11px] text-lx-faint">{{ importCopy.urlHelp }}</p>
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.providerIconLabel') }}</label>
          <div class="flex items-center gap-2">
            <input
              v-model="providerForm.icon"
              :placeholder="t('settings.models.providerIconPlaceholder')"
              :class="[fieldClass, 'flex-1 min-w-0']"
            />
            <ProviderIcon
              v-if="providerForm.icon.trim()"
              :icon="providerForm.icon"
              :name="providerForm.name"
              :size="24"
            />
          </div>
          <p class="mt-1 text-[11px] text-lx-faint">
            {{ t('settings.models.providerIconHelp') }}
          </p>
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.providerApiKeyLabel') }}</label>
          <div class="relative">
            <input
              v-model="providerForm.apiKey"
              data-testid="provider-api-key"
              :type="showApiKey ? 'text' : 'password'"
              :placeholder="providerForm.id !== null ? t('settings.models.apiKeyEditPlaceholder') : t('settings.models.providerApiKeyPlaceholder')"
              :class="[fieldClass, 'pr-10']"
            />
            <button
              type="button"
              @click="showApiKey = !showApiKey"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer p-1"
              :title="showApiKey ? t('settings.models.hideKey') : t('settings.models.showKey')"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
          <p class="mt-1 text-[11px] text-lx-faint">
            {{ importCopy.keyHelp }}
          </p>
        </div>

        <div v-if="providerFormError" class="text-xs text-red-500 font-medium">{{ providerFormError }}</div>
      </div>

      <div class="flex items-center justify-end gap-2.5 pt-2">
        <button type="button" @click="cancelForm" :class="ghostBtnClass">{{ t('common.cancel') }}</button>
        <button
          type="button"
          @click="saveProviderForm"
          :disabled="isSubmitting"
          class="px-5 py-1.5 rounded-xl text-xs font-medium text-white transition cursor-pointer"
          :class="isSubmitting ? 'bg-blue-400 cursor-not-allowed' : (isDark ? 'bg-sky-600 hover:bg-sky-500' : 'bg-blue-600 hover:bg-blue-500 shadow-sm')"
        >
          {{ isSubmitting ? t('common.saving') : providerForm.id === null ? importCopy.next : t('common.save') }}
        </button>
      </div>
    </div>

    <!-- ============================ 模型表单 ============================ -->
    <BatchModelsForm v-else-if="mode === 'batch-form' && batchProvider" :key="batchProvider.id"
      :provider="batchProvider" :existing-names="batchExistingNames" :is-dark="isDark"
      @back="cancelForm" @edit="startEditProvider(batchProvider)" @updated="refreshAfterChange" />

    <div v-else-if="mode === 'batch-form'" class="space-y-3 text-xs" role="alert">
      <p>{{ t('settings.models.errLoadConfig') }}</p>
      <button type="button" :class="ghostBtnClass" @click="cancelForm">{{ importCopy.back }}</button>
    </div>

    <div v-else-if="mode === 'model-form'" class="space-y-4">
      <div class="flex items-center justify-between pb-1 border-b border-zinc-100 dark:border-gray-800">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cancelForm"
            :title="t('settings.models.backToList')"
            :class="['p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition cursor-pointer', isDark ? 'hover:bg-white/5' : 'hover:bg-black/5']"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h4 class="text-sm font-bold tracking-tight text-lx-primary">
            {{ modelForm.id !== null ? t('settings.models.editHeading') : t('settings.models.addModelHeading') }}
          </h4>
        </div>
        <span class="text-[11px] text-gray-400">{{ t('settings.models.modelFormSubtitle') }}</span>
      </div>

      <div class="space-y-3">
        <div>
          <label :class="labelClass">{{ t('settings.models.providerSelectLabel') }}</label>
          <DropUpSelect
            v-model="selectedProviderValue"
            :options="providerOptions"
            :isDark="isDark"
            :searchable="false"
            align="left"
            trigger-class="w-full h-9 px-3 rounded-xl text-xs border flex items-center justify-between gap-2 cursor-pointer"
          >
            <template #trigger="{ selected }">
              <ProviderIcon v-if="selected?.avatar" :icon="selected.avatar" :name="selected.label" :size="14" />
              <span class="truncate">{{ selected?.label ?? ungroupedLabel }}</span>
              <svg class="w-3 h-3 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </template>
          </DropUpSelect>
          <p class="mt-1 text-[11px] text-lx-faint">
            {{ t('settings.models.providerSelectHelp') }}
          </p>
        </div>

        <div class="model-dropdown-container relative" @click.stop>
          <label :class="labelClass">{{ t('settings.models.modelNameLabel') }} <span class="text-red-500">*</span></label>
          <div class="flex items-center gap-2">
            <input v-model="modelForm.modelName" :placeholder="t('settings.models.modelNamePlaceholder')" :class="[fieldClass, 'flex-1 min-w-0']" />
            <button
              type="button"
              :disabled="isFetchingRemoteModels"
              @click="handleFetchRemoteModels"
              :class="[
                'px-3 py-2 rounded-xl text-xs font-medium shrink-0 flex items-center gap-1.5 transition border cursor-pointer select-none',
                isFetchingRemoteModels
                  ? 'opacity-60 cursor-not-allowed border-gray-300 dark:border-gray-600 bg-zinc-100 dark:bg-black text-gray-400'
                  : (isDark
                      ? 'border-white/20 bg-white/[0.06] text-sky-400 hover:bg-white/[0.12]'
                      : 'border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100/80')
              ]"
            >
              <svg v-if="isFetchingRemoteModels" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <span>{{ isFetchingRemoteModels ? t('settings.models.fetching') : t('settings.models.fetchModels') }}</span>
            </button>
          </div>

          <transition name="dropdown-down-center">
            <div
              v-if="isRemoteModelDropdownOpen"
              :class="[
                'absolute left-0 right-0 mt-1 max-h-60 overflow-hidden rounded-xl border shadow-2xl py-1 z-30 flex flex-col text-xs origin-top backdrop-blur-xl',
                isDark ? 'bg-black/95 border-white/20 text-zinc-100' : 'bg-white border-gray-200 text-gray-700'
              ]"
            >
              <div class="p-2 border-b border-lx-border-faint">
                <input
                  v-model="remoteModelSearch"
                  :placeholder="t('settings.models.searchModels')"
                  :class="[
                    'w-full px-2.5 py-1 rounded-lg text-xs outline-none',
                    isDark ? 'bg-white/5 border border-lx-border-subtle text-zinc-100 placeholder-lx-faint' : 'bg-zinc-50 border border-lx-border-subtle text-gray-800 placeholder-lx-faint'
                  ]"
                  @click.stop
                />
              </div>
              <div v-if="isFetchingRemoteModels" class="py-4 text-center text-gray-400">
                {{ t('settings.models.fetchingRemote') }}
              </div>
              <div v-else-if="fetchRemoteModelError" class="p-3 text-red-500 dark:text-red-400 break-all space-y-1">
                <div class="font-medium">{{ t('settings.models.fetchFailed') }}</div>
                <div class="text-[11px] opacity-90">{{ fetchRemoteModelError }}</div>
              </div>
              <div v-else-if="filteredRemoteModels.length === 0" class="py-4 text-center text-gray-400">
                {{ remoteModelSearch ? t('settings.models.noMatch') : t('settings.models.errNoRemote') }}
              </div>
              <div v-else class="overflow-y-auto max-h-48 scrollbar-thin py-0.5">
                <div
                  v-for="item in filteredRemoteModels"
                  :key="item.id"
                  @click="handleSelectRemoteModel(item.id)"
                  :class="[
                    'px-3 py-1.5 cursor-pointer flex items-center justify-between transition',
                    modelForm.modelName === item.id
                      ? (isDark ? 'text-sky-400 font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50/50')
                      : 'text-lx-secondary hover:bg-lx-surface-selected'
                  ]"
                >
                  <div class="font-mono text-xs truncate">{{ item.id }}</div>
                  <div v-if="item.owned_by" class="text-[10px] text-gray-400 truncate ml-2">{{ item.owned_by }}</div>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.baseUrlLabel') }} <span class="text-red-500">*</span></label>
          <input v-model="modelForm.baseUrl" :placeholder="t('settings.models.baseUrlPlaceholder')" :class="fieldClass" />
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.apiKeyLabel') }} <span v-if="modelForm.id === null && !modelForm.useProviderApiKey" class="text-red-500">*</span></label>

          <!-- 只有该提供方确实配了通用密钥时才给这个选项，否则勾了也必然失败 -->
          <label
            v-if="providerHasCredential(modelForm.providerConfigId)"
            class="mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer select-none"
            :class="isDark ? 'border-lx-border hover:border-white/30' : 'border-lx-border hover:border-gray-300'"
          >
            <input v-model="modelForm.useProviderApiKey" type="checkbox" class="mt-0.5 accent-blue-600" />
            <span class="min-w-0">
              <span class="block text-xs font-medium text-lx-secondary">
                {{ t('settings.models.useProviderApiKeyLabel') }}
              </span>
              <span class="block text-[11px] mt-0.5 text-lx-faint">
                {{ t('settings.models.useProviderApiKeyHelp') }}
              </span>
            </span>
          </label>

          <div class="relative">
            <input
              v-model="modelForm.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              :disabled="modelForm.useProviderApiKey"
              :placeholder="modelForm.useProviderApiKey
                ? t('settings.models.useProviderApiKeyPlaceholder')
                : (modelForm.id !== null ? t('settings.models.apiKeyEditPlaceholder') : t('settings.models.apiKeyAddPlaceholder'))"
              :class="[fieldClass, 'pr-10', modelForm.useProviderApiKey ? 'opacity-60 cursor-not-allowed' : '']"
            />
            <button
              type="button"
              @click="showApiKey = !showApiKey"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer p-1"
              :title="showApiKey ? t('settings.models.hideKey') : t('settings.models.showKey')"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>

        <ModelVisionField v-model="modelForm.vision" :is-dark="isDark" />

        <div v-if="modelFormError" class="text-xs text-red-500 font-medium">{{ modelFormError }}</div>
      </div>

      <div class="flex items-center justify-end gap-2.5 pt-2">
        <button type="button" @click="cancelForm" :class="ghostBtnClass">{{ t('common.cancel') }}</button>
        <button
          type="button"
          @click="saveModelForm"
          :disabled="isSubmitting"
          class="px-5 py-1.5 rounded-xl text-xs font-medium text-white transition cursor-pointer"
          :class="isSubmitting ? 'bg-blue-400 cursor-not-allowed' : (isDark ? 'bg-sky-600 hover:bg-sky-500' : 'bg-blue-600 hover:bg-blue-500 shadow-sm')"
        >
          {{ isSubmitting ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 下拉菜单向下展开动画 (顶部居中对齐) */
.dropdown-down-center-enter-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top center;
}

.dropdown-down-center-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
  transform-origin: top center;
}

.dropdown-down-center-enter-from {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.85);
}

.dropdown-down-center-leave-from {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-down-center-leave-to {
  opacity: 0;
  transform: translateY(-6px) scaleY(0.9);
}
</style>
