<script setup lang="ts">
import { computed } from 'vue';
import { useAgentsTab } from './useAgentsTab';
import DropUpSelect from '../../../components/common/DropUpSelect.vue';
import { resolveToolFullName } from '../../../utils/toolDisplayNames';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';
import { isImageAvatar } from '../../../utils/avatar';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

const {
  agentsList,
  isAgentsLoading,
  agentsErrorMsg,
  availableTools,
  isToolsLoading,
  toolsErrorMsg,
  modelOptions,
  selectedModelValue,
  isEditingOrAddingAgent,
  editingAgentId,
  agentForm,
  agentFormError,
  isSubmittingAgent,
  agentToast,
  agentSearchQuery,
  filteredAgents,
  selectedAgentIds,
  batchModelValue,
  isApplyingBatchModel,
  isAllAgentsSelected,
  isAgentSelected,
  toggleAgentSelection,
  toggleAllAgents,
  handleApplyBatchModel,
  loadAgents,
  loadTools,
  getModelName,
  startAddAgent,
  startEditAgent,
  cancelAgentForm,
  toggleAgentTool,
  selectAllAgentTools,
  clearAgentTools,
  handleSaveAgent,
  handleDeleteAgent,
} = useAgentsTab();
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="agentToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ agentToast }}</span>
    </div>

    <!-- 列表视图 -->
    <div v-if="!isEditingOrAddingAgent" class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
                    <h4 class="text-base font-bold tracking-tight" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
            {{ t('settings.agents.title') }}
          </h4>
          <p class="text-xs mt-0.5" :class="isDark ? 'text-zinc-400 text-glow-subtle' : 'text-gray-500'">
            {{ t('settings.agents.subtitle') }}
          </p>
        </div>
        <button
          type="button"
          @click="startAddAgent"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer shadow-sm transition"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
                    <span>{{ t('settings.agents.add') }}</span>
        </button>
      </div>

      <!-- 加载中 -->
            <div v-if="isAgentsLoading" class="py-8 text-center text-xs text-lx-faint">
        {{ t('settings.agents.loading') }}
      </div>

      <!-- 加载失败 -->
      <div v-else-if="agentsErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ agentsErrorMsg }}</p>
        <button
          type="button"
          @click="loadAgents"
                    class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="agentsList.length === 0"
        class="py-12 text-center text-xs border border-dashed rounded-2xl border-lx-border-subtle text-lx-faint"
      >
        {{ t('settings.agents.empty') }}
      </div>

      <template v-else>
        <!-- 工具条：搜索 + 勾选 + 批量改模型，与卡片区同宽一行排布 -->
        <div class="flex flex-wrap items-center gap-2">
          <!-- 搜索框：只过滤展示，不动已勾选项（勾了再搜不会丢选择） -->
          <div class="relative flex-1 min-w-[7rem]">
            <svg
              class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none text-lx-faint"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              v-model="agentSearchQuery"
              type="text"
              :placeholder="t('settings.agents.searchPlaceholder')"
              :class="[
                'w-full h-[30px] pl-8 pr-7 rounded-lg border outline-none text-xs transition',
                isDark
                  ? 'bg-lx-surface-elevated border-lx-border-strong text-zinc-100 placeholder-lx-faint focus:border-cyan-400'
                  : 'bg-lx-surface-elevated border-lx-border-strong text-gray-900 placeholder-lx-faint focus:border-blue-500'
              ]"
            />
            <button
              v-if="agentSearchQuery"
              type="button"
              :title="t('settings.agents.clearSearch')"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded cursor-pointer text-lx-faint hover:text-lx-tertiary"
              @click="agentSearchQuery = ''"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <label class="flex items-center gap-2 shrink-0 cursor-pointer select-none px-1">
            <input
              type="checkbox"
              :checked="isAllAgentsSelected"
              class="rounded text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 cursor-pointer"
              @change="toggleAllAgents"
            />
            <span class="text-xs text-lx-tertiary">
              {{ t('settings.agents.selectedCount', { count: selectedAgentIds.length }) }}
            </span>
          </label>

          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-lx-muted">
              {{ t('settings.agents.batchLabel') }}
            </span>
            <DropUpSelect
              v-model="batchModelValue"
              :options="modelOptions"
              :isDark="isDark"
              :searchable="true"
              :placeholder="t('settings.agents.batchModelPlaceholder')"
              trigger-class="h-[30px] px-2.5 rounded-lg text-xs border flex items-center justify-between gap-2 cursor-pointer min-w-[8rem]"
            />
            <button
              type="button"
              :disabled="isApplyingBatchModel || selectedAgentIds.length === 0"
              @click="handleApplyBatchModel"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition shadow-sm"
              :class="
                isApplyingBatchModel || selectedAgentIds.length === 0
                  ? 'bg-blue-400 cursor-not-allowed'
                  : (isDark ? 'bg-sky-600 hover:bg-sky-500 text-glow-white' : 'bg-blue-600 hover:bg-blue-500')
              "
            >
              {{ t('settings.agents.applyBatch') }}
            </button>
          </div>
        </div>

        <!-- 搜索无结果：与「一个智能体都没有」区分开，否则用户以为数据丢了 -->
        <div
          v-if="filteredAgents.length === 0"
          class="py-10 text-center text-xs border border-dashed rounded-2xl border-lx-border-subtle text-lx-faint"
        >
          {{ t('settings.agents.emptySearch') }}
        </div>

        <!-- 智能体卡片列表 -->
        <div v-else class="space-y-3">
          <div
            v-for="agent in filteredAgents"
            :key="agent.id"
            class="px-4 py-3.5 rounded-2xl border transition-all"
            :class="[
              isAgentSelected(agent.id)
                ? (isDark
                    ? 'bg-sky-500/[0.08] border-sky-500/50 shadow-[0_0_20px_rgba(56,189,248,0.18)]'
                    : 'bg-blue-50/60 border-blue-400 shadow-sm')
                : (isDark
                    ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
                    : 'bg-zinc-50/70 border-zinc-200 hover:border-zinc-300')
            ]"
          >
            <div class="flex items-start justify-between gap-3">
              <!-- 勾选列与卡片内容并排；批量改模型只认这一列 -->
              <input
                type="checkbox"
                :checked="isAgentSelected(agent.id)"
                class="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded text-blue-600 focus:ring-blue-500"
                @change="toggleAgentSelection(agent.id)"
              />
              <div class="space-y-1.5 min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <!-- 头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
                  <img
                    v-if="isImageAvatar(agent.avatar)"
                    :src="agent.avatar"
                    :alt="agent.name"
                    class="w-5 h-5 rounded-full object-cover shrink-0"
                  />
                  <span
                    v-else-if="agent.avatar"
                    class="w-5 h-5 rounded-full flex items-center justify-center text-xs leading-none shrink-0 select-none"
                    :class="isDark ? 'bg-white/10' : 'bg-zinc-200/80'"
                  >{{ agent.avatar }}</span>
                  <span class="text-sm font-semibold truncate" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
                    {{ agent.name }}
                  </span>
                  <span
                    class="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                    :class="[
                      isDark
                        ? 'bg-white/5 border-white/15 text-sky-400 text-glow-cyan'
                        : 'bg-blue-50 border-blue-200 text-blue-700'
                    ]"
                  >
                    {{ getModelName(agent.modelId) }}
                  </span>
                </div>
                              <p class="text-xs line-clamp-2 text-lx-muted">
                  {{ agent.description || t('settings.agents.noDescription') }}
                </p>
                <!-- 已分配工具展示 -->
                <div class="pt-1">
                  <div class="text-[11px] font-medium mb-1 flex items-center gap-1.5 text-lx-tertiary">
                    <span>{{ t('settings.agents.assignedTools') }}</span>
                    <span class="text-xs font-normal text-lx-faint">
                      ({{ agent.toolList?.length || 0 }})
                    </span>
                  </div>
                  <div v-if="agent.toolList && agent.toolList.length > 0" class="flex flex-wrap gap-1.5">
                    <span
                      v-for="toolName in agent.toolList"
                      :key="toolName"
                      class="px-2 py-0.5 rounded-md text-[10px] border"
                      :class="[
                        isDark
                          ? 'bg-white/5 border-white/15 text-emerald-400'
                          : 'bg-white border-zinc-200 text-emerald-700 shadow-2xs'
                      ]"
                    >
                      {{ resolveToolFullName(toolName) }}
                    </span>
                  </div>
                  <span v-else class="text-[11px] italic text-lx-faint">{{ t('settings.agents.noTools') }}</span>
                </div>
              </div>

              <!-- 操作按键 -->
              <div class="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  @click="startEditAgent(agent)"
                  class="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 transition cursor-pointer"
                  :title="t('settings.agents.editAction')"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  type="button"
                  @click="handleDeleteAgent(agent)"
                  class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 transition cursor-pointer"
                  :title="t('settings.agents.deleteAction')"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 新增 / 编辑表单模式 -->
    <div v-else class="space-y-4">
      <div class="flex items-center justify-between border-b pb-3" :class="isDark ? 'border-gray-800' : 'border-zinc-200'">
        <div>
                    <h4 class="text-base font-bold tracking-tight text-lx-primary">
            {{ editingAgentId ? t('settings.agents.editHeading') : t('settings.agents.addHeading') }}
          </h4>
          <p class="text-xs text-lx-muted mt-0.5">
            {{ t('settings.agents.formSubtitle') }}
          </p>
        </div>
        <button
          type="button"
          @click="cancelAgentForm"
          class="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-zinc-200 cursor-pointer"
        >
                    {{ t('common.backToList') }}
        </button>
      </div>

      <div v-if="agentFormError" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
        {{ agentFormError }}
      </div>

      <div class="space-y-3 text-xs">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
                        <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
              {{ t('settings.agents.nameLabel') }} <span class="text-red-500">*</span>
            </label>
            <input
              v-model="agentForm.name"
                            :placeholder="t('settings.agents.namePlaceholder')"
              :class="[
                'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
                isDark ? 'bg-lx-surface-elevated border-lx-border-strong text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-lx-surface-elevated border-lx-border-strong text-gray-900 focus:border-blue-500'
              ]"
            />
          </div>
          <div>
                        <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
              {{ t('settings.agents.modelLabel') }} <span class="text-red-500">*</span>
            </label>
            <!-- 基座模型：与输入框共用同一套分组下拉，替代原生 select 的系统外观 -->
            <DropUpSelect
              v-model="selectedModelValue"
              :options="modelOptions"
              :isDark="isDark"
              :searchable="true"
              :placeholder="t('settings.agents.modelPlaceholder')"
              class="w-full"
              trigger-class="w-full h-[34px] px-3 rounded-xl text-xs border flex items-center justify-between gap-2 cursor-pointer"
            />
          </div>
        </div>

        <div>
          <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            {{ t('settings.agents.descriptionLabel') }}
          </label>
          <input
            v-model="agentForm.description"
            :placeholder="t('settings.agents.descriptionPlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-lx-surface-elevated border-lx-border-strong text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-lx-surface-elevated border-lx-border-strong text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <div>
          <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            {{ t('settings.agents.avatarLabel') }}
          </label>
          <input
            v-model="agentForm.avatar"
            :placeholder="t('settings.agents.avatarPlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-lx-surface-elevated border-lx-border-strong text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-lx-surface-elevated border-lx-border-strong text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <div>
          <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
                        {{ t('settings.agents.promptLabel') }} <span class="text-red-500">*</span>
          </label>
          <textarea
            v-model="agentForm.prompt"
            rows="3"
            :placeholder="t('settings.agents.promptPlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs resize-none transition',
              isDark ? 'bg-lx-surface-elevated border-lx-border-strong text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-lx-surface-elevated border-lx-border-strong text-gray-900 focus:border-blue-500'
            ]"
          ></textarea>
        </div>

        <!-- 工具分配模块 -->
        <div class="pt-1">
          <div class="flex items-center justify-between mb-1.5">
            <label class="block font-medium" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
                            {{ t('settings.agents.toolsLabel') }}
              <span class="font-normal ml-1 text-lx-muted">
                {{ t('settings.agents.toolsCount', { selected: agentForm.toolList.length, total: availableTools.length }) }}
              </span>
            </label>
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="selectAllAgentTools"
                class="cursor-pointer"
                :class="isDark ? 'text-sky-400 hover:text-sky-300 text-glow-cyan' : 'text-blue-500 hover:text-blue-400'"
              >
                                {{ t('settings.agents.selectAll') }}
              </button>
              <span :class="isDark ? 'text-zinc-600' : 'text-gray-400'">|</span>
              <button
                type="button"
                @click="clearAgentTools"
                class="cursor-pointer"
                :class="isDark ? 'text-lx-muted hover:text-zinc-200' : 'text-lx-muted hover:text-gray-400'"
              >
                                {{ t('settings.agents.clear') }}
              </button>
            </div>
          </div>

          <div
            v-if="isToolsLoading"
            class="p-3 text-center border border-dashed rounded-xl border-lx-border-subtle text-lx-faint"
          >
                        {{ t('settings.agents.toolsLoading') }}
          </div>
          <div
            v-else-if="toolsErrorMsg"
            class="p-3 text-center border border-dashed rounded-xl flex items-center justify-center gap-2 border-lx-danger-border text-lx-danger"
          >
            <span>{{ toolsErrorMsg }}</span>
            <button
              type="button"
              @click="loadTools"
                            class="text-blue-500 hover:text-blue-400 cursor-pointer"
            >
              {{ t('common.retry') }}
            </button>
          </div>
          <div
            v-else-if="availableTools.length === 0"
            class="p-3 text-center border border-dashed rounded-xl border-lx-border-subtle text-lx-faint"
          >
            {{ t('settings.agents.noToolsRegistered') }}
          </div>
          <div
            v-else
            class="max-h-48 overflow-y-auto rounded-xl border p-2 grid grid-cols-1 sm:grid-cols-2 gap-2 border-lx-border bg-lx-surface-elevated"
          >
            <div
              v-for="tool in availableTools"
              :key="tool.name"
              @click="toggleAgentTool(tool.name)"
              :class="[
                'p-2.5 rounded-lg border transition-all cursor-pointer flex flex-col justify-between text-left',
                agentForm.toolList.includes(tool.name)
                  ? (isDark ? 'bg-white/10 border-white/30 text-white text-glow-subtle' : 'bg-blue-50 border-blue-300 text-blue-900')
                  : (isDark ? 'bg-white/[0.03] border-lx-border-subtle text-zinc-300 hover:border-white/30' : 'bg-zinc-50/80 border-lx-border-subtle text-gray-700 hover:border-zinc-300')
              ]"
            >
              <div class="flex items-center justify-between gap-1">
                <div class="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    :checked="agentForm.toolList.includes(tool.name)"
                    class="rounded text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 pointer-events-none"
                  />
                  <span class="font-medium truncate">{{ resolveToolFullName(tool.name) }}</span>
                </div>
                <span
                  class="text-[9px] px-1.5 py-0.5 rounded font-normal shrink-0"
                  :class="tool.readOnly ? (isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700')"
                >
                  {{ tool.readOnly ? t('settings.agents.readOnly') : t('settings.agents.readWrite') }}
                </span>
              </div>
              <div v-if="tool.description" class="text-[11px] truncate mt-1" :class="isDark ? 'text-zinc-400' : 'text-gray-400'" :title="tool.description">
                {{ tool.description }}
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-2 border-t border-lx-border-subtle">
          <button
            type="button"
            @click="cancelAgentForm"
            class="px-3 py-1.5 rounded-xl border text-xs cursor-pointer transition"
            :class="isDark ? 'border-white/20 hover:bg-white/10 text-zinc-200 text-glow-subtle' : 'border-zinc-300 text-gray-500 hover:text-gray-700'"
          >
                        {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="isSubmittingAgent"
            @click="handleSaveAgent"
            class="px-4 py-1.5 rounded-xl text-xs font-medium text-white cursor-pointer transition shadow-sm"
            :class="[
              isSubmittingAgent ? 'bg-blue-400 cursor-not-allowed' : (isDark ? 'bg-sky-600 hover:bg-sky-500 text-glow-white shadow-[0_0_15px_rgba(56,189,248,0.4)]' : 'bg-blue-600 hover:bg-blue-500')
            ]"
          >
            {{ isSubmittingAgent ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
