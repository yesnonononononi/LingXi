<script setup lang="ts">
import { useTeamsTab } from './useTeamsTab';

defineProps<{
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'modelUpdated'): void;
}>();

const {
  teamsList,
  isTeamsLoading,
  teamsErrorMsg,
  isEditingOrAddingTeam,
  editingTeamId,
  teamForm,
  teamFormError,
  isSubmittingTeam,
  teamToast,
  agentsList,
  getAgentName,
  loadTeams,
  startAddTeam,
  startEditTeam,
  cancelTeamForm,
  toggleTeamMember,
  selectedTeamAgents,
  handleSaveTeam,
  handleDeleteTeam,
} = useTeamsTab(() => emit('modelUpdated'));
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="teamToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ teamToast }}</span>
    </div>

    <!-- 列表视图 -->
    <div v-if="!isEditingOrAddingTeam" class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white">
            团队协同
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            组织多个智能体协同分工，指定管理者分配任务与调度成员。
          </p>
        </div>
        <button
          type="button"
          @click="startAddTeam"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer shadow-sm transition"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span>新建团队</span>
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="isTeamsLoading" class="py-8 text-center text-xs text-gray-400">
        正在加载团队列表...
      </div>

      <!-- 加载失败 -->
      <div v-else-if="teamsErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ teamsErrorMsg }}</p>
        <button
          type="button"
          @click="loadTeams"
          class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          重试
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="teamsList.length === 0"
        class="py-12 text-center text-xs text-gray-400 dark:text-gray-500 border border-dashed rounded-2xl"
        :class="isDark ? 'border-gray-800' : 'border-gray-200'"
      >
        暂无配置的协同团队，请点击上方「新建团队」进行添加。
      </div>

      <!-- 团队卡片列表 -->
      <div v-else class="space-y-3">
        <div
          v-for="team in teamsList"
          :key="team.id"
          class="p-3.5 rounded-xl border transition-all"
          :class="[
            isDark
              ? 'bg-[#151c2c] border-[#252f44] hover:border-gray-700'
              : 'bg-gray-50/70 border-gray-200 hover:border-gray-300'
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1.5 min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-semibold text-gray-900 dark:text-white">
                  {{ team.name }}
                </span>
                <!-- 管理者徽章 -->
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1"
                  :class="[
                    isDark
                      ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                      : 'bg-blue-50 border-blue-200 text-blue-700'
                  ]"
                >
                  <svg class="w-3 h-3 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span>管理者: {{ team.commanderName || getAgentName(team.commanderAgentId) || '未指定' }}</span>
                </span>
                <!-- 成员总数徽章 -->
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                  :class="[
                    isDark
                      ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                      : 'bg-purple-50 border-purple-200 text-purple-700'
                  ]"
                >
                  {{ team.agents?.length || 0 }} 位成员
                </span>
              </div>

              <!-- 团队描述展示 -->
              <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                {{ team.description || '暂无团队描述' }}
              </p>

              <!-- 团队成员标签列表 -->
              <div class="pt-1">
                <div class="text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-1 flex items-center gap-1.5">
                  <span>团队成员:</span>
                </div>
                <div v-if="team.agents && team.agents.length > 0" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="agent in team.agents"
                    :key="agent.id"
                    class="px-2 py-0.5 rounded-md text-[10px] border flex items-center gap-1"
                    :class="[
                      agent.id === team.commanderAgentId
                        ? (isDark ? 'bg-blue-600/20 border-blue-500/40 text-blue-300 font-medium' : 'bg-blue-50 border-blue-300 text-blue-800 font-medium')
                        : (isDark ? 'bg-[#0f172a] border-[#2b374f] text-gray-300' : 'bg-white border-gray-200 text-gray-700 shadow-2xs')
                    ]"
                  >
                    <span>{{ agent.name }}</span>
                    <span v-if="agent.id === team.commanderAgentId" class="text-[9px] px-1 py-0.2 rounded bg-blue-500/20 text-blue-500 font-normal">
                      管理者
                    </span>
                    <span v-if="agent.toolList?.length" class="text-[9px] text-gray-400">
                      ({{ agent.toolList.length }}工具)
                    </span>
                  </span>
                </div>
                <span v-else class="text-[11px] text-gray-400 italic">暂无成员详情</span>
              </div>
            </div>

            <!-- 操作按键：编辑 & 删除 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="startEditTeam(team)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 transition cursor-pointer"
                title="编辑团队"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                type="button"
                @click="handleDeleteTeam(team)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 transition cursor-pointer"
                title="删除团队"
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

    <!-- 新增 / 编辑团队表单模式 -->
    <div v-else class="space-y-4">
      <div class="flex items-center justify-between border-b pb-3" :class="isDark ? 'border-gray-800' : 'border-gray-200'">
        <div>
          <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white">
            {{ editingTeamId ? `编辑团队「${teamForm.name || '未命名团队'}」` : '新建团队' }}
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            设置团队成员与团队管理者，明确团队分工与职责定位。
          </p>
        </div>
        <button
          type="button"
          @click="cancelTeamForm"
          class="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-gray-200 cursor-pointer"
        >
          返回列表
        </button>
      </div>

      <!-- 表单错误信息提示 -->
      <div v-if="teamFormError" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
        {{ teamFormError }}
      </div>

      <div class="space-y-3.5 text-xs">
        <!-- 团队名称 -->
        <div>
          <label class="block text-gray-700 dark:text-gray-300 font-medium mb-1">
            团队名称 <span class="text-red-500">*</span>
          </label>
          <input
            v-model="teamForm.name"
            placeholder="例如: 全栈开发组 / 算法重构协同团队"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-[#101725] border-[#2b374f] text-white focus:border-blue-500' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <!-- 团队描述 (编辑团队描述) -->
        <div>
          <label class="block text-gray-700 dark:text-gray-300 font-medium mb-1">
            团队描述
          </label>
          <textarea
            v-model="teamForm.description"
            rows="2"
            placeholder="简要说明团队的业务职责与协同目标..."
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs resize-none transition',
              isDark ? 'bg-[#101725] border-[#2b374f] text-white focus:border-blue-500' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
            ]"
          ></textarea>
        </div>

        <!-- 团队成员选择 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-gray-700 dark:text-gray-300 font-medium">
              团队成员 Agent <span class="text-red-500">*</span>
              <span class="text-gray-400 font-normal ml-1">
                (已选 {{ teamForm.agentIds.length }} 个，上限 10 个)
              </span>
            </label>
          </div>

          <div
            class="rounded-xl border divide-y overflow-y-auto max-h-44"
            :class="[
              isDark ? 'border-[#2b374f] divide-[#2b374f] bg-[#101725]' : 'border-gray-200 divide-gray-100 bg-gray-50'
            ]"
          >
            <div v-if="agentsList.length === 0" class="p-4 text-center text-xs text-gray-400">
              暂无可用 Agent，请先在「智能体」设置中新建。
            </div>
            <div
              v-else
              v-for="agent in agentsList"
              :key="agent.id"
              @click="toggleTeamMember(agent.id)"
              :class="[
                'p-2.5 flex items-center justify-between cursor-pointer transition-colors text-xs',
                teamForm.agentIds.includes(agent.id)
                  ? (isDark ? 'bg-blue-600/15' : 'bg-blue-50')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-gray-100/80')
              ]"
            >
              <div class="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                <input
                  type="checkbox"
                  :checked="teamForm.agentIds.includes(agent.id)"
                  class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4 pointer-events-none"
                />
                <div class="truncate">
                  <div class="flex items-center gap-1.5">
                    <span class="font-medium text-gray-800 dark:text-gray-200 truncate">
                      {{ agent.name }}
                    </span>
                    <span
                      v-if="agent.toolList && agent.toolList.length > 0"
                      class="px-1.5 py-0.2 text-[9px] rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20"
                    >
                      {{ agent.toolList.length }} 个工具
                    </span>
                  </div>
                  <div class="text-[11px] text-gray-400 truncate">
                    {{ agent.description || '暂无描述' }}
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <span
                  v-if="teamForm.commanderAgentId === agent.id"
                  class="px-2 py-0.5 text-[10px] rounded-full bg-blue-500/20 text-blue-500 border border-blue-500/30 font-medium"
                >
                  管理者
                </span>
                <button
                  v-else-if="teamForm.agentIds.includes(agent.id)"
                  type="button"
                  @click.stop="teamForm.commanderAgentId = agent.id"
                  class="px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-blue-500 hover:bg-blue-500/10 cursor-pointer transition"
                >
                  设为管理者
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 团队管理者选择 -->
        <div>
          <label class="block text-gray-700 dark:text-gray-300 font-medium mb-1">
            团队管理者 (Manager) <span class="text-red-500">*</span>
            <span class="text-gray-400 font-normal ml-1">
              (必须是已选团队成员之一)
            </span>
          </label>

          <div v-if="selectedTeamAgents.length === 0" class="text-xs text-amber-500 dark:text-amber-400 p-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5">
            请先勾选上方团队成员，才能指定团队管理者。
          </div>

          <select
            v-else
            v-model="teamForm.commanderAgentId"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs cursor-pointer',
              isDark ? 'bg-[#101725] border-[#2b374f] text-white focus:border-blue-500' : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
            ]"
          >
            <option v-for="agent in selectedTeamAgents" :key="agent.id" :value="agent.id">
              {{ agent.name }} {{ agent.description ? `(${agent.description})` : '' }}
            </option>
          </select>
        </div>

        <!-- 底部操作按钮 -->
        <div class="flex items-center justify-end gap-2.5 pt-3 border-t" :class="isDark ? 'border-gray-800' : 'border-gray-200'">
          <button
            type="button"
            @click="cancelTeamForm"
            :class="[
              'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
              isDark
                ? 'border-gray-700 hover:bg-white/5 text-gray-300'
                : 'border-gray-200 hover:bg-gray-50 text-gray-700'
            ]"
          >
            取消
          </button>
          <button
            type="button"
            :disabled="isSubmittingTeam"
            @click="handleSaveTeam"
            class="px-4 py-1.5 rounded-xl text-xs font-medium text-white cursor-pointer transition shadow-sm"
            :class="[
              isSubmittingTeam ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'
            ]"
          >
            {{ isSubmittingTeam ? '正在保存...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
