<script setup lang="ts">
import { computed } from 'vue';
import { useAgentsTab } from './useAgentsTab';
import { useTheme } from '../../../composables/useTheme';

const props = defineProps<{
  isDark?: boolean;
}>();

const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

const {
  agentsList,
  isAgentsLoading,
  agentsErrorMsg,
  availableTools,
  isToolsLoading,
  toolsErrorMsg,
  modelsList,
  isEditingOrAddingAgent,
  editingAgentId,
  agentForm,
  agentFormError,
  isSubmittingAgent,
  agentToast,
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
            智能体
          </h4>
          <p class="text-xs mt-0.5" :class="isDark ? 'text-zinc-400 text-glow-subtle' : 'text-gray-500'">
            配置智能体角色，为其绑定基座模型并分配专属执行工具。
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
          <span>新建智能体</span>
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="isAgentsLoading" class="py-8 text-center text-xs" :class="isDark ? 'text-zinc-500' : 'text-gray-400'">
        正在加载智能体列表...
      </div>

      <!-- 加载失败 -->
      <div v-else-if="agentsErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ agentsErrorMsg }}</p>
        <button
          type="button"
          @click="loadAgents"
          class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          重试
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="agentsList.length === 0"
        class="py-12 text-center text-xs border border-dashed rounded-2xl"
        :class="isDark ? 'border-white/10 text-zinc-500' : 'border-gray-200 text-gray-400'"
      >
        暂无配置的智能体，请点击上方「新建智能体」进行添加。
      </div>

      <!-- 智能体卡片列表 -->
      <div v-else class="space-y-3">
        <div
          v-for="agent in agentsList"
          :key="agent.id"
          class="px-4 py-3.5 rounded-2xl border transition-all"
          :class="[
            isDark
              ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
              : 'bg-gray-50/70 border-gray-200 hover:border-gray-300'
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1.5 min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
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
              <p class="text-xs line-clamp-2" :class="isDark ? 'text-zinc-400' : 'text-gray-500'">
                {{ agent.description || '暂无描述' }}
              </p>
              <!-- 已分配工具展示 -->
              <div class="pt-1">
                <div class="text-[11px] font-medium mb-1 flex items-center gap-1.5" :class="isDark ? 'text-zinc-300' : 'text-gray-600'">
                  <span>已分配工具:</span>
                  <span class="text-xs font-normal" :class="isDark ? 'text-zinc-500' : 'text-gray-400'">
                    ({{ agent.toolList?.length || 0 }})
                  </span>
                </div>
                <div v-if="agent.toolList && agent.toolList.length > 0" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="toolName in agent.toolList"
                    :key="toolName"
                    class="px-2 py-0.5 rounded-md text-[10px] font-mono border"
                    :class="[
                      isDark
                        ? 'bg-white/5 border-white/15 text-emerald-400'
                        : 'bg-white border-gray-200 text-emerald-700 shadow-2xs'
                    ]"
                  >
                    {{ toolName }}
                  </span>
                </div>
                <span v-else class="text-[11px] italic" :class="isDark ? 'text-zinc-500' : 'text-gray-400'">未配置任何工具</span>
              </div>
            </div>

            <!-- 操作按键 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="startEditAgent(agent)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 transition cursor-pointer"
                title="编辑智能体"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                type="button"
                @click="handleDeleteAgent(agent)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 transition cursor-pointer"
                title="删除智能体"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑表单模式 -->
    <div v-else class="space-y-4">
      <div class="flex items-center justify-between border-b pb-3" :class="isDark ? 'border-gray-800' : 'border-gray-200'">
        <div>
          <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white">
            {{ editingAgentId ? '编辑智能体' : '新建智能体' }}
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            设定智能体身份设定，并配置其可调用的后端工具能力。
          </p>
        </div>
        <button
          type="button"
          @click="cancelAgentForm"
          class="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-gray-200 cursor-pointer"
        >
          返回列表
        </button>
      </div>

      <div v-if="agentFormError" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
        {{ agentFormError }}
      </div>

      <div class="space-y-3 text-xs">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
              智能体名称 <span class="text-red-500">*</span>
            </label>
            <input
              v-model="agentForm.name"
              placeholder="例如: CodeReviewer"
              :class="[
                'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
                isDark ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
              ]"
            />
          </div>
          <div>
            <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
              基座模型 <span class="text-red-500">*</span>
            </label>
            <select
              v-model="agentForm.modelId"
              :class="[
                'w-full px-3 py-2 rounded-xl border outline-none text-xs cursor-pointer transition',
                isDark ? 'bg-black/90 border-white/20 text-zinc-100 focus:border-cyan-400' : 'bg-white border-gray-300 text-gray-900'
              ]"
            >
              <option v-for="m in modelsList" :key="m.id" :value="m.id" class="dark:bg-black dark:text-zinc-100">
                {{ m.modelName || `模型 #${m.id}` }}
              </option>
            </select>
          </div>
        </div>

        <div>
          <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            描述信息
          </label>
          <input
            v-model="agentForm.description"
            placeholder="简短描述该 Agent 的能力或分工定位..."
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <div>
          <label class="block font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            角色设定 / 提示词 <span class="text-red-500">*</span>
          </label>
          <textarea
            v-model="agentForm.prompt"
            rows="3"
            placeholder="例如: 你是一位资深代码评审专家，善于发现代码坏味道与潜在缺陷..."
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs resize-none transition',
              isDark ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
            ]"
          ></textarea>
        </div>

        <!-- 工具分配模块 -->
        <div class="pt-1">
          <div class="flex items-center justify-between mb-1.5">
            <label class="block font-medium" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
              分配工具
              <span class="font-normal ml-1" :class="isDark ? 'text-zinc-400' : 'text-gray-500'">
                (已选 {{ agentForm.toolList.length }} / {{ availableTools.length }})
              </span>
            </label>
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="selectAllAgentTools"
                class="cursor-pointer"
                :class="isDark ? 'text-sky-400 hover:text-sky-300 text-glow-cyan' : 'text-blue-500 hover:text-blue-400'"
              >
                全选
              </button>
              <span :class="isDark ? 'text-zinc-600' : 'text-gray-400'">|</span>
              <button
                type="button"
                @click="clearAgentTools"
                class="cursor-pointer"
                :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-gray-500 hover:text-gray-400'"
              >
                清空
              </button>
            </div>
          </div>

          <div
            v-if="isToolsLoading"
            class="p-3 text-center border border-dashed rounded-xl"
            :class="isDark ? 'border-white/10 text-zinc-500' : 'border-gray-200 text-gray-400'"
          >
            正在加载工具列表...
          </div>
          <div
            v-else-if="toolsErrorMsg"
            class="p-3 text-center border border-dashed rounded-xl flex items-center justify-center gap-2"
            :class="isDark ? 'border-red-900/60 text-red-300' : 'border-red-200 text-red-600'"
          >
            <span>{{ toolsErrorMsg }}</span>
            <button
              type="button"
              @click="loadTools"
              class="text-blue-500 hover:text-blue-400 cursor-pointer"
            >
              重试
            </button>
          </div>
          <div
            v-else-if="availableTools.length === 0"
            class="p-3 text-center border border-dashed rounded-xl"
            :class="isDark ? 'border-white/10 text-zinc-500' : 'border-gray-200 text-gray-400'"
          >
            后端未注册任何可用工具
          </div>
          <div
            v-else
            class="max-h-48 overflow-y-auto rounded-xl border p-2 grid grid-cols-1 sm:grid-cols-2 gap-2"
            :class="isDark ? 'border-white/15 bg-black/90' : 'border-gray-200 bg-white'"
          >
            <div
              v-for="tool in availableTools"
              :key="tool.name"
              @click="toggleAgentTool(tool.name)"
              :class="[
                'p-2.5 rounded-lg border transition-all cursor-pointer flex flex-col justify-between text-left',
                agentForm.toolList.includes(tool.name)
                  ? (isDark ? 'bg-white/10 border-white/30 text-white text-glow-subtle' : 'bg-blue-50 border-blue-300 text-blue-900')
                  : (isDark ? 'bg-white/[0.03] border-white/10 text-zinc-300 hover:border-white/30' : 'bg-gray-50/80 border-gray-200 text-gray-700 hover:border-gray-300')
              ]"
            >
              <div class="flex items-center justify-between gap-1">
                <div class="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    :checked="agentForm.toolList.includes(tool.name)"
                    class="rounded text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 pointer-events-none"
                  />
                  <span class="font-medium truncate font-mono">{{ tool.name }}</span>
                </div>
                <span
                  class="text-[9px] px-1.5 py-0.5 rounded font-normal shrink-0"
                  :class="tool.readOnly ? (isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700')"
                >
                  {{ tool.readOnly ? '只读' : '读写' }}
                </span>
              </div>
              <div v-if="tool.description" class="text-[11px] truncate mt-1" :class="isDark ? 'text-zinc-400' : 'text-gray-400'" :title="tool.description">
                {{ tool.description }}
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-2 border-t" :class="isDark ? 'border-white/10' : 'border-gray-200'">
          <button
            type="button"
            @click="cancelAgentForm"
            class="px-3 py-1.5 rounded-xl border text-xs cursor-pointer transition"
            :class="isDark ? 'border-white/20 hover:bg-white/10 text-zinc-200 text-glow-subtle' : 'border-gray-300 text-gray-500 hover:text-gray-700'"
          >
            取消
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
            {{ isSubmittingAgent ? '正在保存...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
