<script setup lang="ts">
import { computed } from 'vue';
import { useTeamsTab, TEAM_SIZE_MIN, TEAM_SIZE_MAX } from './useTeamsTab';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';
import { isImageAvatar, avatarOptionPrefix } from '../../../utils/avatar';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

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
  maxMemberSize,
  teamSizeInput,
  isSavingTeamSize,
  saveTeamSize,
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
      <!-- 团队规模上限：真值在设置行（team_size），改完即时生效，不需要重启 -->
      <div
        class="flex items-center justify-between pb-3 border-b"
        :class="isDark ? 'border-white/10' : 'border-zinc-100'"
      >
        <div class="flex flex-col">
          <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">
            {{ t('settings.teams.maxMemberSizeLabel') }}
          </span>
          <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">
            {{ t('settings.teams.maxMemberSizeDesc', { min: TEAM_SIZE_MIN, max: TEAM_SIZE_MAX }) }}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span
            v-if="isSavingTeamSize"
            class="text-[11px] text-gray-400 dark:text-zinc-400"
          >{{ t('common.saving') }}</span>
          <input
            v-model.number="teamSizeInput"
            type="number"
            :min="TEAM_SIZE_MIN"
            :max="TEAM_SIZE_MAX"
            :disabled="isSavingTeamSize"
            :title="t('settings.teams.maxMemberSizeDesc', { min: TEAM_SIZE_MIN, max: TEAM_SIZE_MAX })"
            @change="saveTeamSize"
            :class="[
              'w-16 px-2 py-1 rounded-xl border outline-none text-xs text-center transition [color-scheme:light] dark:[color-scheme:dark]',
              isDark ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80' : 'bg-white border-zinc-300 text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div>
                    <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white dark:text-glow-white">
            {{ t('settings.teams.title') }}
          </h4>
          <p class="text-xs text-lx-muted dark:text-glow-subtle mt-0.5">
            {{ t('settings.teams.subtitle') }}
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
                    <span>{{ t('settings.teams.add') }}</span>
        </button>
      </div>

      <!-- 加载中 -->
            <div v-if="isTeamsLoading" class="py-8 text-center text-xs text-gray-400">
        {{ t('settings.teams.loading') }}
      </div>

      <!-- 加载失败 -->
      <div v-else-if="teamsErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ teamsErrorMsg }}</p>
        <button
          type="button"
          @click="loadTeams"
                    class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="teamsList.length === 0"
        class="py-12 text-center text-xs text-lx-faint border border-dashed rounded-2xl"
                :class="isDark ? 'border-white/10' : 'border-gray-200'"
      >
        {{ t('settings.teams.empty') }}
      </div>

      <!-- 团队卡片列表 -->
      <div v-else class="space-y-3">
        <div
          v-for="team in teamsList"
          :key="team.id"
          class="px-4 py-3.5 rounded-2xl border transition-all"
          :class="[
            isDark
              ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
              : 'bg-zinc-50/70 border-gray-200 hover:border-zinc-300'
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1.5 min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <!-- 头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
                <img
                  v-if="isImageAvatar(team.avatar)"
                  :src="team.avatar"
                  :alt="team.name"
                  class="w-5 h-5 rounded-full object-cover shrink-0"
                />
                <span
                  v-else-if="team.avatar"
                  class="w-5 h-5 rounded-full flex items-center justify-center text-xs leading-none shrink-0 select-none"
                  :class="isDark ? 'bg-white/10' : 'bg-gray-200/80'"
                >{{ team.avatar }}</span>
                <span class="text-sm font-semibold text-gray-900 dark:text-white dark:text-glow-subtle">
                  {{ team.name }}
                </span>
                <!-- 管理者徽章 -->
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1"
                  :class="[
                    isDark
                      ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300'
                      : 'bg-blue-50 border-blue-200 text-blue-700'
                  ]"
                >
                  <svg class="w-3 h-3 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span>{{ t('settings.teams.commanderPrefix', { name: team.commanderName || getAgentName(team.commanderAgentId) || t('settings.teams.unassigned') }) }}</span>
                </span>
                <!-- 成员总数徽章 -->
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                  :class="[
                    isDark
                      ? 'bg-purple-500/15 border-purple-500/30 text-purple-300'
                      : 'bg-purple-50 border-purple-200 text-purple-700'
                  ]"
                >
                  {{ t('settings.teams.memberCount', { count: team.agents?.length || 0 }) }}
                </span>
              </div>

              <!-- 团队描述展示 -->
                            <p class="text-xs text-lx-muted line-clamp-2">
                {{ team.description || t('settings.teams.noDescription') }}
              </p>

              <!-- 团队成员标签列表 -->
              <div class="pt-1">
                <div class="text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-1 flex items-center gap-1.5">
                  <span>{{ t('settings.teams.membersLabel') }}</span>
                </div>
                <div v-if="team.agents && team.agents.length > 0" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="agent in team.agents"
                    :key="agent.id"
                    class="px-2 py-0.5 rounded-md text-[10px] border flex items-center gap-1"
                    :class="[
                      agent.id === team.commanderAgentId
                        ? (isDark ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-200 font-medium' : 'bg-blue-50 border-blue-300 text-blue-800 font-medium')
                        : (isDark ? 'bg-white/[0.04] border-white/10 text-zinc-300' : 'bg-white border-gray-200 text-gray-700 shadow-2xs')
                    ]"
                  >
                    <!-- 成员小头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
                    <img
                      v-if="isImageAvatar(agent.avatar)"
                      :src="agent.avatar"
                      :alt="agent.name"
                      class="w-3.5 h-3.5 rounded-full object-cover shrink-0"
                    />
                    <span v-else-if="agent.avatar" class="leading-none shrink-0 select-none">{{ agent.avatar }}</span>
                    <span>{{ agent.name }}</span>
                                        <span v-if="agent.id === team.commanderAgentId" class="text-[9px] px-1 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-normal">
                      {{ t('settings.teams.commander') }}
                    </span>
                    <span v-if="agent.toolList?.length" class="text-[9px] text-zinc-400">
                      {{ t('settings.teams.toolCount', { count: agent.toolList.length }) }}
                    </span>
                  </span>
                </div>
                <span v-else class="text-[11px] text-gray-400 italic">{{ t('settings.teams.noMemberDetail') }}</span>
              </div>
            </div>

            <!-- 操作按键：编辑 & 删除 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="startEditTeam(team)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-cyan-400 dark:hover:text-cyan-300 hover:bg-white/5 transition cursor-pointer"
                :title="t('settings.teams.editAction')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                type="button"
                @click="handleDeleteTeam(team)"
                class="p-1.5 rounded-lg text-gray-400 hover:text-red-400 dark:hover:text-red-400 hover:bg-white/5 transition cursor-pointer"
                :title="t('settings.teams.deleteAction')"
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
      <div class="flex items-center justify-between border-b pb-3" :class="isDark ? 'border-white/10' : 'border-gray-200'">
        <div>
          <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white dark:text-glow-white">
                        {{ editingTeamId ? t('settings.teams.editHeading', { name: teamForm.name || t('settings.teams.unnamedTeam') }) : t('settings.teams.addHeading') }}
          </h4>
          <p class="text-xs text-lx-muted dark:text-glow-subtle mt-0.5">
            {{ t('settings.teams.formSubtitle') }}
          </p>
        </div>
        <button
          type="button"
          @click="cancelTeamForm"
          class="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-zinc-200 cursor-pointer"
        >
                    {{ t('common.backToList') }}
        </button>
      </div>

      <!-- 表单错误信息提示 -->
      <div v-if="teamFormError" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
        {{ teamFormError }}
      </div>

      <div class="space-y-3.5 text-xs">
        <!-- 团队名称 -->
        <div>
          <label class="block text-gray-700 dark:text-zinc-300 font-medium mb-1">
                        {{ t('settings.teams.nameLabel') }} <span class="text-red-500">*</span>
          </label>
          <input
            v-model="teamForm.name"
            :placeholder="t('settings.teams.namePlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80' : 'bg-white border-zinc-300 text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <!-- 团队描述 (编辑团队描述) -->
        <div>
          <label class="block text-gray-700 dark:text-zinc-300 font-medium mb-1">
                        {{ t('settings.teams.descriptionLabel') }}
          </label>
          <textarea
            v-model="teamForm.description"
            rows="2"
            :placeholder="t('settings.teams.descriptionPlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs resize-none transition',
              isDark ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80' : 'bg-white border-zinc-300 text-gray-900 focus:border-blue-500'
            ]"
          ></textarea>
        </div>

        <!-- 团队头像 -->
        <div>
          <label class="block text-gray-700 dark:text-zinc-300 font-medium mb-1">
            {{ t('settings.teams.avatarLabel') }}
          </label>
          <input
            v-model="teamForm.avatar"
            :placeholder="t('settings.teams.avatarPlaceholder')"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs transition',
              isDark ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80' : 'bg-white border-zinc-300 text-gray-900 focus:border-blue-500'
            ]"
          />
        </div>

        <!-- 团队成员选择 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-gray-700 dark:text-zinc-300 font-medium">
                            {{ t('settings.teams.membersSelectLabel') }} <span class="text-red-500">*</span>
              <span class="text-gray-400 font-normal ml-1">
                {{ t('settings.teams.membersSelectCount', { selected: teamForm.agentIds.length, max: maxMemberSize }) }}
              </span>
            </label>
          </div>

          <div
            class="rounded-xl border divide-y overflow-y-auto max-h-44"
            :class="[
              isDark ? 'border-white/15 divide-white/10 bg-black/90' : 'border-gray-200 divide-zinc-100 bg-zinc-50'
            ]"
          >
                        <div v-if="agentsList.length === 0" class="p-4 text-center text-xs text-gray-400">
              {{ t('settings.teams.noAgents') }}
            </div>
            <div
              v-else
              v-for="agent in agentsList"
              :key="agent.id"
              @click="toggleTeamMember(agent.id)"
              :class="[
                'p-2.5 flex items-center justify-between cursor-pointer transition-colors text-xs',
                teamForm.agentIds.includes(agent.id)
                  ? (isDark ? 'bg-cyan-500/15' : 'bg-blue-50')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-zinc-100/80')
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
                  <!-- 成员小头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
                  <img
                    v-if="isImageAvatar(agent.avatar)"
                    :src="agent.avatar"
                    :alt="agent.name"
                    class="w-3.5 h-3.5 rounded-full object-cover shrink-0"
                  />
                  <span
                    v-else-if="agent.avatar"
                    class="text-[10px] leading-none shrink-0 select-none"
                  >{{ agent.avatar }}</span>
                  <span class="font-medium text-gray-800 dark:text-gray-200 truncate">
                    {{ agent.name }}
                  </span>
                    <span
                      v-if="agent.toolList && agent.toolList.length > 0"
                      class="px-1.5 py-0.2 text-[9px] rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20"
                    >
                                            {{ t('settings.teams.agentToolCount', { count: agent.toolList.length }) }}
                    </span>
                  </div>
                  <div class="text-[11px] text-gray-400 truncate">
                    {{ agent.description || t('settings.agents.noDescription') }}
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <span
                  v-if="teamForm.commanderAgentId === agent.id"
                  class="px-2 py-0.5 text-[10px] rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-medium"
                >
                                    {{ t('settings.teams.commander') }}
                </span>
                <button
                  v-else-if="teamForm.agentIds.includes(agent.id)"
                  type="button"
                  @click.stop="teamForm.commanderAgentId = agent.id"
                  class="px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 cursor-pointer transition"
                >
                                    {{ t('settings.teams.setAsCommander') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 团队管理者选择 -->
        <div>
          <label class="block text-gray-700 dark:text-zinc-300 font-medium mb-1">
                        {{ t('settings.teams.commanderLabel') }} <span class="text-red-500">*</span>
            <span class="text-gray-400 font-normal ml-1">
              {{ t('settings.teams.commanderHint') }}
            </span>
          </label>

          <div v-if="selectedTeamAgents.length === 0" class="text-xs text-amber-500 dark:text-amber-400 p-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5">
                        {{ t('settings.teams.selectMembersFirst') }}
          </div>

          <select
            v-else
            v-model="teamForm.commanderAgentId"
            :class="[
              'w-full px-3 py-2 rounded-xl border outline-none text-xs cursor-pointer [color-scheme:dark]',
              isDark ? 'bg-black border-white/20 text-white focus:border-cyan-400' : 'bg-white border-zinc-300 text-gray-900 focus:border-blue-500'
            ]"
          >
            <option v-for="agent in selectedTeamAgents" :key="agent.id" :value="agent.id" class="bg-black text-white">
              {{ avatarOptionPrefix(agent.avatar) }}{{ agent.name }} {{ agent.description ? `(${agent.description})` : '' }}
            </option>
          </select>
        </div>

        <!-- 底部操作按钮 -->
        <div class="flex items-center justify-end gap-2.5 pt-3 border-t" :class="isDark ? 'border-white/10' : 'border-gray-200'">
          <button
            type="button"
            @click="cancelTeamForm"
            :class="[
              'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
              isDark
                ? 'border-white/15 hover:bg-white/5 text-zinc-300'
                : 'border-gray-200 hover:bg-zinc-50 text-gray-700'
            ]"
          >
                        {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="isSubmittingTeam"
            @click="handleSaveTeam"
            class="px-4 py-1.5 rounded-xl text-xs font-medium text-white cursor-pointer transition shadow-sm"
            :class="[
              isSubmittingTeam ? 'bg-cyan-600/50 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-500 shadow-[0_0_15px_rgba(8,145,178,0.4)]'
            ]"
          >
            {{ isSubmittingTeam ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
