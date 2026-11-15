<script setup lang="ts">
import {computed, onMounted} from 'vue';
import {useModelsTab} from './useModelsTab';
import {useTheme} from '../../../composables/useTheme';
import {useI18n} from '../../../i18n';
import ModelAdvancedOptions from '../../../components/model/ModelAdvancedOptions.vue';
import ProviderIcon from '../../../components/model/ProviderIcon.vue';
import DropUpSelect from '../../../components/common/DropUpSelect.vue';
import type {SelectOption} from '../../../types/ui';
import BatchModelsForm from './BatchModelsForm.vue';
import {useModelImportCopy} from './useModelImportCopy';
import {useUserConfigStore} from '../../../stores/userConfigStore';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const importCopy = useModelImportCopy();
const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

// 流式输出是全局设置（不属于单个模型），走全局配置 store 而非模型表单。
const configStore = useUserConfigStore();
const streamChatSaving = computed(() => configStore.savingKeys.has('streamChat'));
const streamChatDisabled = computed(() => !configStore.loaded || streamChatSaving.value);
const toggleStreamChat = async (next: boolean) => {
  await configStore.patch('streamChat', next, { streamChat: next });
};
const switchClass = computed(() => [
  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
  configStore.streamChat ? 'bg-lx-accent' : 'bg-lx-surface-active',
]);

// 全局配置可能尚未加载（用户直接打开「模型」页签）：主动拉一次，否则开关永远 disabled。
onMounted(() => {
  configStore.load();
});

const emit = defineEmits<{
  (e: 'modelUpdated'): void;
  (e: 'openCompaction'): void;
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

const fieldClass =
  'w-full h-9 px-3 rounded-xl text-xs border border-lx-border bg-lx-surface-sunken text-lx-primary placeholder:text-lx-faint outline-none focus:border-lx-border-strong focus:ring-2 focus:ring-lx-surface-active transition';
const labelClass = 'block text-xs font-medium text-lx-primary-soft mb-1.5';
const cardClass = 'rounded-2xl border border-lx-border-subtle overflow-hidden transition-colors';
const ghostBtnClass =
  'h-8 px-3 rounded-xl border border-lx-border text-xs font-medium text-lx-secondary hover:bg-lx-surface-hover hover:text-lx-primary transition cursor-pointer';
const primaryBtnClass =
  'inline-flex items-center justify-center h-8 px-3.5 rounded-xl text-xs font-medium bg-lx-accent hover:bg-lx-accent-hover text-lx-on-accent transition cursor-pointer shrink-0 active:scale-[0.98]';
const dangerBtnClass =
  'h-8 px-2.5 rounded-xl text-xs font-medium text-lx-danger hover:bg-lx-danger-soft transition cursor-pointer';
const addRowClass =
  'w-full py-2.5 text-lx-fs-sm flex items-center justify-center gap-1.5 border-t border-lx-border-faint text-lx-muted hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer';
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="modelToast"
      class="px-3.5 py-2.5 rounded-xl text-xs bg-lx-success-soft border border-lx-success text-lx-success transition-all flex items-center justify-between"
    >
      <span>{{ modelToast }}</span>
    </div>

    <!-- ============================== 列表 ============================== -->
    <div v-if="mode === 'list'" class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="text-sm font-bold tracking-tight text-lx-primary">
            {{ t('settings.models.title') }}
          </h4>
          <p class="text-lx-fs-sm mt-0.5 leading-relaxed text-lx-muted">
            {{ t('settings.models.subtitle') }}
          </p>
        </div>
        <div class="shrink-0 flex items-center gap-2">
          <button
            type="button"
            data-testid="open-compaction"
            @click="emit('openCompaction')"
            :class="ghostBtnClass"
          >
            {{ t('settings.nav.compaction') }}
          </button>
          <button
            type="button"
            @click="startAddProvider()"
            :class="primaryBtnClass"
          >
            {{ t('settings.models.addProvider') }}
          </button>
        </div>
      </div>

      <!-- 流式输出：全局开关，控制主对话/子 Agent 请求是否逐字流式返回 -->
      <section
        class="rounded-2xl border border-lx-border-subtle px-4 py-3.5 flex items-center justify-between gap-4"
        data-testid="stream-chat-card"
      >
        <div class="min-w-0">
          <h5 class="text-xs font-medium text-lx-primary-soft">
            {{ t('settings.models.streamChatTitle') }}
          </h5>
          <p class="text-lx-fs-sm leading-relaxed mt-0.5 text-lx-muted">
            {{ t('settings.models.streamChatDesc') }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="stream-chat-switch"
          :aria-checked="configStore.streamChat"
          :aria-label="t('settings.models.streamChatToggleLabel')"
          :disabled="streamChatDisabled"
          :class="switchClass"
          @click="toggleStreamChat(!configStore.streamChat)"
        >
          <span :class="['absolute h-4 w-4 rounded-full bg-lx-on-accent shadow transition', configStore.streamChat ? 'translate-x-4' : 'translate-x-1']" />
        </button>
      </section>

      <div v-if="isModelLoading" class="py-8 text-center text-xs text-lx-faint">
        {{ t('settings.models.loading') }}
      </div>

      <div v-else-if="modelErrorMsg" class="py-6 text-center text-xs text-lx-danger space-y-2 rounded-2xl border border-dashed border-lx-border-subtle">
        <p>{{ modelErrorMsg }}</p>
        <button
          type="button"
          @click="loadAll"
          :class="ghostBtnClass"
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
        <section v-for="(group, groupIndex) in catalogGroups" :key="group.providerConfigId ?? `ungrouped-${groupIndex}`" :class="cardClass">
          <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-lx-border-faint">
            <div class="flex items-center gap-2 min-w-0">
              <ProviderIcon :icon="group.providerIcon" :name="group.providerName" :size="18" />
              <span class="font-semibold text-xs text-lx-primary truncate">
                {{ groupTitle(group.providerName) }}
              </span>
              <span
                class="shrink-0 text-lx-fs-xs px-2 py-0.5 rounded-full border border-lx-border-subtle text-lx-muted tracking-tight"
              >{{ t('settings.models.providerModels', { count: group.modelCount }) }}</span>
            </div>
            <div v-if="group.providerConfigId" class="flex items-center gap-1.5 shrink-0">
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

          <div>
            <div
              v-for="(item, itemIndex) in group.models"
              :key="item.id"
              :class="[
                'flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-lx-surface-hover transition-colors',
                itemIndex > 0 ? 'border-t border-lx-border-faint' : ''
              ]"
            >
              <span class="text-xs truncate text-lx-secondary">
                {{ item.modelName || t('settings.models.unnamed') }}
              </span>
              <div class="flex items-center gap-1 shrink-0">
                <button type="button" class="text-lx-fs-sm px-2.5 py-1 rounded-lg transition cursor-pointer text-lx-muted hover:text-lx-primary hover:bg-lx-surface-selected" @click="startEditModel(item)">
                  {{ t('common.edit') }}
                </button>
                <button type="button" class="text-lx-fs-sm px-2.5 py-1 rounded-lg transition cursor-pointer text-lx-danger hover:bg-lx-danger-soft" @click="handleDeleteModel(item)">
                  {{ t('common.remove') }}
                </button>
              </div>
            </div>

            <div v-if="group.models.length === 0" class="px-4 py-3 text-lx-fs-sm text-lx-faint">
              {{ t('settings.models.emptyGroup') }}
            </div>

            <button type="button" :class="addRowClass" @click="startAddModel(group.providerConfigId ?? null)">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              {{ t('settings.models.addModel') }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- ========================== 提供商表单 ========================== -->
    <div v-else-if="mode === 'provider-form'" class="space-y-4">
      <div class="flex items-center justify-between pb-3 border-b border-lx-border-faint">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cancelForm"
            :title="t('settings.models.backToList')"
            class="p-1.5 rounded-xl text-lx-muted hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h4 class="text-sm font-bold tracking-tight text-lx-primary">
            {{ providerForm.id !== null ? t('settings.models.editProviderHeading') : t('settings.models.addProviderHeading') }}
          </h4>
        </div>
        <span class="text-lx-fs-sm text-lx-muted">{{ t('settings.models.providerFormSubtitle') }}</span>
      </div>

      <div class="space-y-3.5">
        <div v-if="providerForm.id === null" class="flex items-center gap-3 text-xs text-lx-muted" aria-label="steps">
          <span class="text-lx-accent font-medium">1 · {{ importCopy.connection }}</span><span>→</span><span>2 · {{ importCopy.selection }}</span>
        </div>
        <div>
          <label :class="labelClass">{{ t('settings.models.providerNameLabel') }} <span class="text-lx-danger">*</span></label>
          <input v-model="providerForm.name" data-testid="provider-name" :placeholder="t('settings.models.providerNamePlaceholder')" :class="fieldClass" />
        </div>

        <div>
          <label for="provider-base-url" :class="labelClass">{{ t('settings.models.baseUrlLabel') }} <span class="text-lx-danger">*</span></label>
          <input id="provider-base-url" v-model="providerForm.baseUrl" :placeholder="t('settings.models.baseUrlPlaceholder')" :class="fieldClass" />
          <p class="mt-1 text-lx-fs-sm text-lx-faint">{{ importCopy.urlHelp }}</p>
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
          <p class="mt-1 text-lx-fs-sm text-lx-faint">
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
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-lx-muted hover:text-lx-primary cursor-pointer p-1 transition"
              :title="showApiKey ? t('settings.models.hideKey') : t('settings.models.showKey')"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
          <p class="mt-1 text-lx-fs-sm text-lx-faint">
            {{ importCopy.keyHelp }}
          </p>
        </div>

        <div v-if="providerFormError" class="text-xs text-lx-danger font-medium">{{ providerFormError }}</div>
      </div>

      <div class="flex items-center justify-end gap-2.5 pt-2">
        <button type="button" @click="cancelForm" :class="[ghostBtnClass, 'h-9 px-4']">{{ t('common.cancel') }}</button>
        <button
          type="button"
          @click="saveProviderForm"
          :disabled="isSubmitting"
          :class="[
            'inline-flex items-center justify-center h-9 px-5 rounded-xl text-xs font-medium text-lx-on-accent transition cursor-pointer',
            isSubmitting ? 'bg-lx-accent opacity-60 cursor-not-allowed' : 'bg-lx-accent hover:bg-lx-accent-hover active:scale-[0.98]'
          ]"
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
      <div class="flex items-center justify-between pb-3 border-b border-lx-border-faint">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cancelForm"
            :title="t('settings.models.backToList')"
            class="p-1.5 rounded-xl text-lx-muted hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h4 class="text-sm font-bold tracking-tight text-lx-primary">
            {{ modelForm.id !== null ? t('settings.models.editHeading') : t('settings.models.addModelHeading') }}
          </h4>
        </div>
        <span class="text-lx-fs-sm text-lx-muted">{{ t('settings.models.modelFormSubtitle') }}</span>
      </div>

      <div class="space-y-3.5">
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
              <svg class="w-3 h-3 shrink-0 text-lx-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </template>
          </DropUpSelect>
          <p class="mt-1 text-lx-fs-sm text-lx-faint">
            {{ t('settings.models.providerSelectHelp') }}
          </p>
        </div>

        <div class="model-dropdown-container relative" @click.stop>
          <label :class="labelClass">{{ t('settings.models.modelNameLabel') }} <span class="text-lx-danger">*</span></label>
          <div class="flex items-center gap-2">
            <input v-model="modelForm.modelName" :placeholder="t('settings.models.modelNamePlaceholder')" :class="[fieldClass, 'flex-1 min-w-0']" />
            <button
              type="button"
              :disabled="isFetchingRemoteModels"
              @click="handleFetchRemoteModels"
              :class="[
                'h-9 px-3 rounded-xl text-xs font-medium shrink-0 flex items-center gap-1.5 transition border border-lx-border cursor-pointer select-none',
                isFetchingRemoteModels
                  ? 'opacity-60 cursor-not-allowed bg-lx-surface-sunken text-lx-muted'
                  : 'bg-lx-accent-soft text-lx-accent hover:bg-lx-surface-hover'
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
              class="absolute left-0 right-0 mt-1 max-h-60 overflow-hidden rounded-xl border border-lx-border bg-lx-surface-elevated text-lx-primary shadow-2xl py-1 z-30 flex flex-col text-xs origin-top backdrop-blur-xl"
            >
              <div class="p-2 border-b border-lx-border-faint">
                <input
                  v-model="remoteModelSearch"
                  :placeholder="t('settings.models.searchModels')"
                  class="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none bg-lx-surface-sunken border border-lx-border-subtle text-lx-primary placeholder:text-lx-faint"
                  @click.stop
                />
              </div>
              <div v-if="isFetchingRemoteModels" class="py-4 text-center text-lx-muted">
                {{ t('settings.models.fetchingRemote') }}
              </div>
              <div v-else-if="fetchRemoteModelError" class="p-3 text-lx-danger break-all space-y-1">
                <div class="font-medium">{{ t('settings.models.fetchFailed') }}</div>
                <div class="text-lx-fs-sm opacity-90">{{ fetchRemoteModelError }}</div>
              </div>
              <div v-else-if="filteredRemoteModels.length === 0" class="py-4 text-center text-lx-muted">
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
                      ? 'text-lx-accent font-medium bg-lx-accent-soft'
                      : 'text-lx-secondary hover:bg-lx-surface-selected'
                  ]"
                >
                  <div class="font-mono text-xs truncate">{{ item.id }}</div>
                  <div v-if="item.owned_by" class="text-lx-fs-xs text-lx-muted truncate ml-2">{{ item.owned_by }}</div>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.baseUrlLabel') }} <span class="text-lx-danger">*</span></label>
          <input v-model="modelForm.baseUrl" :placeholder="t('settings.models.baseUrlPlaceholder')" :class="fieldClass" />
        </div>

        <div>
          <label :class="labelClass">{{ t('settings.models.apiKeyLabel') }} <span v-if="modelForm.id === null && !modelForm.useProvider" class="text-lx-danger">*</span></label>

          <label
            class="mb-2 flex items-start gap-2 rounded-xl border border-lx-border hover:border-lx-border-strong px-3 py-2.5 cursor-pointer select-none transition"
          >
            <input v-model="modelForm.useProvider" data-testid="model-use-provider" type="checkbox" class="mt-0.5 accent-lx-accent" />
            <span class="min-w-0">
              <span class="block text-xs font-medium text-lx-secondary">
                {{ t('settings.models.useProviderApiKeyLabel') }}
              </span>
              <span class="block text-lx-fs-sm mt-0.5 text-lx-faint">
                {{ t('settings.models.useProviderApiKeyHelp') }}
              </span>
            </span>
          </label>

          <div class="relative">
            <input
              v-model="modelForm.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              :disabled="modelForm.useProvider"
              :placeholder="modelForm.useProvider
                ? t('settings.models.useProviderApiKeyPlaceholder')
                : (modelForm.id !== null ? t('settings.models.apiKeyEditPlaceholder') : t('settings.models.apiKeyAddPlaceholder'))"
              :class="[fieldClass, 'pr-10', modelForm.useProvider ? 'opacity-60 cursor-not-allowed' : '']"
            />
            <button
              type="button"
              @click="showApiKey = !showApiKey"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-lx-muted hover:text-lx-primary cursor-pointer p-1 transition"
              :title="showApiKey ? t('settings.models.hideKey') : t('settings.models.showKey')"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>

        <ModelAdvancedOptions v-model:vision="modelForm.vision" v-model:provider="modelForm.provider" :is-dark="isDark" />

        <div v-if="modelFormError" class="text-xs text-lx-danger font-medium">{{ modelFormError }}</div>
      </div>

      <div class="flex items-center justify-end gap-2.5 pt-2">
        <button type="button" @click="cancelForm" :class="[ghostBtnClass, 'h-9 px-4']">{{ t('common.cancel') }}</button>
        <button
          type="button"
          @click="saveModelForm"
          :disabled="isSubmitting"
          :class="[
            'inline-flex items-center justify-center h-9 px-5 rounded-xl text-xs font-medium text-lx-on-accent transition cursor-pointer',
            isSubmitting ? 'bg-lx-accent opacity-60 cursor-not-allowed' : 'bg-lx-accent hover:bg-lx-accent-hover active:scale-[0.98]'
          ]"
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
