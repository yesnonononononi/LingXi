<script setup lang="ts">
import { computed } from 'vue';
import { useMcpTab } from './useMcpTab';
import { MCP_TRANSPORTS } from '../../../types/chat';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const {
  mcpList,
  isMcpLoading,
  mcpErrorMsg,
  isEditingOrAddingMcp,
  editingMcpId,
  mcpFormError,
  isSubmittingMcp,
  isConnectingMcp,
  mcpConnectionResult,
  mcpConnectionError,
  mcpRowConnections,
  mcpToast,
  mcpForm,
  mcpHeadersPristine,
  mcpEnvPristine,
  loadMcp,
  startAddMcp,
  startEditMcp,
  cancelMcpForm,
  handleSaveMcp,
  handleConnectMcp,
  handleConnectSavedMcp,
  handleDeleteMcp,
  handleToggleMcp,
  countHeaders,
  countEnvVars,
  resolveConnectionLabel,
} = useMcpTab();
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="mcpToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ mcpToast }}</span>
    </div>

    <!-- 列表视图 -->
    <div v-if="!isEditingOrAddingMcp" class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
                    <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white dark:text-glow-white">
            {{ t('settings.mcp.title') }}
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 dark:text-glow-subtle mt-0.5">
            {{ t('settings.mcp.subtitle') }}
          </p>
                </div>
        <button
          type="button"
          @click="startAddMcp"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium cursor-pointer shadow-sm transition whitespace-nowrap shrink-0"
        >
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="whitespace-nowrap">{{ t('settings.mcp.add') }}</span>
        </button>
      </div>

      <!-- 加载中 -->
            <div v-if="isMcpLoading" class="py-8 text-center text-xs text-gray-400">
        {{ t('settings.mcp.loading') }}
      </div>

      <!-- 加载失败 -->
      <div v-else-if="mcpErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ mcpErrorMsg }}</p>
        <button
          type="button"
          @click="loadMcp"
                    class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          {{ t('common.retry') }}
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="mcpList.length === 0"
        class="py-12 text-center text-xs text-gray-400 dark:text-gray-500 border border-dashed rounded-2xl"
                :class="isDark ? 'border-white/10' : 'border-gray-200'"
      >
        {{ t('settings.mcp.empty') }}
      </div>

      <!-- 服务卡片列表 -->
      <div v-else class="space-y-3">
        <div
          v-for="item in mcpList"
          :key="item.id"
          class="px-4 py-3.5 rounded-2xl border transition-all"
          :class="[
            isDark
              ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
              : 'bg-gray-50/70 border-gray-200 hover:border-gray-300'
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-semibold text-gray-900 dark:text-white dark:text-glow-subtle truncate">
                  {{ item.name }}
                </span>
                <!-- 启停状态徽标 -->
                <span
                  class="px-1.5 py-0.5 rounded-md text-[10px] font-medium shrink-0 border"
                  :class="item.status === 0
                    ? (isDark ? 'bg-white/5 border-white/10 text-zinc-400' : 'bg-gray-200 border-gray-300 text-gray-500')
                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'"
                >
                  {{ item.status === 0 ? t('settings.mcp.disabled') : t('settings.mcp.enabled') }}
                </span>
                <!-- 传输方式 -->
                <span
                  class="px-1.5 py-0.5 rounded-md text-[10px] shrink-0 border"
                  :class="isDark ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-black/5 border-gray-200 text-gray-500'"
                >
                  {{ item.transport || 'streamable-http' }}
                </span>
                <!-- stdio 环境依赖提示：黄圈白底感叹号，hover 说明 npx/PATH 限制 -->
                                <span
                  v-if="item.transport === 'stdio'"
                  class="inline-flex shrink-0 cursor-help"
                  :title="t('settings.mcp.stdioHintTitle')"
                >
                  <svg
                    class="w-3.5 h-3.5"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="#f59e0b"
                    stroke-width="1.4"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="8" r="7" fill="#ffffff" />
                    <path stroke-linecap="round" d="M8 4.6v4.2" />
                    <circle cx="8" cy="11.4" r="0.85" fill="#f59e0b" stroke="none" />
                  </svg>
                </span>
              </div>

              <!-- 服务描述：随提示词下发给模型，让模型判断该服务是否相关 -->
              <p v-if="item.description" class="text-xs text-gray-600 dark:text-gray-300 mt-1 break-words">
                {{ item.description }}
              </p>

              <!-- 连接信息：http 系显示端点，stdio 显示启动命令 -->
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 break-all font-mono">
                {{ resolveConnectionLabel(item) }}
              </p>

              <div class="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
                                <span v-if="countHeaders(item) > 0">
                  {{ t('settings.mcp.headersCount', { count: countHeaders(item) }) }}
                </span>
                <span v-if="countEnvVars(item) > 0">
                  {{ t('settings.mcp.envCount', { count: countEnvVars(item) }) }}
                </span>
                <span v-if="item.executionTimeout">
                  {{ t('settings.mcp.timeoutSeconds', { seconds: Math.round(item.executionTimeout / 1000) }) }}
                </span>
                <span v-if="item.maxOutput">
                  {{ t('settings.mcp.maxOutputValue', { value: item.maxOutput }) }}
                </span>
              </div>
            </div>

            <!-- 操作区 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="handleToggleMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-zinc-300 hover:bg-white/5'
                    : 'text-gray-600 hover:bg-black/5'
                ]"
              >
                {{ item.status === 0 ? t('settings.mcp.enable') : t('settings.mcp.disable') }}
              </button>
              <button
                type="button"
                @click="startEditMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-cyan-400 hover:bg-white/5'
                    : 'text-blue-600 hover:bg-black/5'
                ]"
                            >
                {{ t('common.edit') }}
              </button>
              <button
                type="button"
                @click="handleDeleteMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-red-400 hover:bg-white/5'
                    : 'text-red-500 hover:bg-black/5'
                ]"
                            >
                {{ t('common.remove') }}
              </button>
              <button
                type="button"
                :disabled="mcpRowConnections[item.id]?.loading"
                :aria-busy="mcpRowConnections[item.id]?.loading || false"
                @click="handleConnectSavedMcp(item)"
                class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition cursor-pointer disabled:cursor-wait"
              >
                <span v-if="mcpRowConnections[item.id]?.loading" class="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true"></span>
                {{ mcpRowConnections[item.id]?.loading ? t('settings.mcp.connecting') : mcpRowConnections[item.id]?.success ? t('settings.mcp.connected') : t('settings.mcp.testConnection') }}
              </button>
            </div>
          </div>
          <p v-if="mcpRowConnections[item.id]?.error" role="alert" class="mt-2 text-xs text-red-500 dark:text-red-400">{{ mcpRowConnections[item.id]?.error }}</p>
        </div>
      </div>
    </div>

    <!-- 编辑 / 新增表单 -->
    <div v-else class="space-y-4">
      <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white dark:text-glow-white">
                {{ editingMcpId ? t('settings.mcp.editHeading') : t('settings.mcp.addHeading') }}
      </h4>

      <!-- 服务名称 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcp.nameLabel') }}</label>
        <input
          v-model="mcpForm.name"
          type="text"
          :placeholder="t('settings.mcp.namePlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 传输方式 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300 inline-flex items-center gap-1.5">
                    {{ t('settings.mcp.transportLabel') }}
          <!-- stdio 环境依赖提示：黄圈白底感叹号，hover 说明 npx/PATH 限制 -->
          <span
            v-if="mcpForm.transport === 'stdio'"
            class="inline-flex cursor-help"
            :title="t('settings.mcp.stdioHintTitle')"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="#f59e0b"
              stroke-width="1.4"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="7" fill="#ffffff" />
              <path stroke-linecap="round" d="M8 4.6v4.2" />
              <circle cx="8" cy="11.4" r="0.85" fill="#f59e0b" stroke="none" />
            </svg>
          </span>
        </label>
        <div class="flex items-center gap-2">
          <button
            v-for="t in MCP_TRANSPORTS"
            :key="t"
            type="button"
            @click="mcpForm.transport = t"
            :class="[
              'px-3 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
              mcpForm.transport === t
                ? 'bg-cyan-600 border-cyan-500 text-white shadow-[0_0_12px_rgba(8,145,178,0.4)]'
                : (isDark
                    ? 'border-white/15 text-zinc-300 hover:bg-white/5'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50')
            ]"
          >
            {{ t }}
          </button>
        </div>
                <p v-if="mcpForm.transport === 'stdio'" class="text-[11px] text-gray-400 dark:text-gray-500">
          {{ t('settings.mcp.stdioHintText') }}
        </p>
      </div>

      <!-- 服务地址（http 系传输） -->
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcp.urlLabel') }}</label>
        <input
          v-model="mcpForm.url"
          type="text"
          :placeholder="t('settings.mcp.urlPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- stdio 启动命令 -->
      <div v-if="mcpForm.transport === 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          {{ t('settings.mcp.commandLabel') }}
          <span class="text-gray-400 dark:text-gray-500 font-normal">{{ t('settings.mcp.commandHint') }}</span>
        </label>
        <textarea
          v-model="mcpForm.commandLines"
          rows="3"
          :placeholder="t('settings.mcp.commandPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition resize-none font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        ></textarea>
      </div>

      <!-- stdio 环境变量 -->
      <div v-if="mcpForm.transport === 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          {{ t('settings.mcp.envLabel') }}
          <span class="text-gray-400 dark:text-gray-500 font-normal">{{ t('settings.mcp.envHint') }}</span>
        </label>
        <textarea
          v-model="mcpForm.envLines"
          @input="mcpEnvPristine = false"
          rows="3"
          :placeholder="t('settings.mcp.envPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition resize-none font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        ></textarea>
        <p
          v-if="mcpEnvPristine && mcpForm.envLines"
          class="text-[11px] text-gray-400 dark:text-gray-500"
        >
                    {{ t('settings.mcp.envPristineHint') }}
        </p>
      </div>

      <!-- 请求头（http 系传输） -->
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          {{ t('settings.mcp.headersLabel') }}
          <span class="text-gray-400 dark:text-gray-500 font-normal">{{ t('settings.mcp.headersHint') }}</span>
        </label>
        <textarea
          v-model="mcpForm.headerLines"
          @input="mcpHeadersPristine = false"
          rows="3"
          :placeholder="t('settings.mcp.headersPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition resize-none font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        ></textarea>
        <p
          v-if="mcpHeadersPristine && mcpForm.headerLines"
          class="text-[11px] text-gray-400 dark:text-gray-500"
        >
                    {{ t('settings.mcp.headersPristineHint') }}
        </p>
      </div>

      <!-- 服务描述：随提示词下发给模型（每服务一行），由业务用户填写 -->
      <div class="space-y-1.5">
                <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          {{ t('settings.mcp.descriptionLabel') }}
          <span class="text-gray-400 dark:text-gray-500 font-normal">{{ t('settings.mcp.descriptionHint') }}</span>
        </label>
        <input
          v-model="mcpForm.description"
          type="text"
          maxlength="200"
          :placeholder="t('settings.mcp.descriptionPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 超时与输出上限 -->
      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcp.initTimeoutLabel') }}</label>
          <input
            v-model.number="mcpForm.initializationTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcp.execTimeoutLabel') }}</label>
          <input
            v-model.number="mcpForm.executionTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcp.maxOutputLabel') }}</label>
          <input
            v-model.number="mcpForm.maxOutput"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
      </div>

      <!-- 启用开关 -->
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input v-model="mcpForm.enabled" type="checkbox" class="w-3.5 h-3.5 cursor-pointer accent-cyan-500" />
        <span class="text-xs text-gray-700 dark:text-gray-300">{{ t('settings.mcp.enableService') }}</span>
      </label>

      <!-- 表单错误 -->
      <div
        v-if="mcpFormError"
        class="p-2.5 rounded-xl text-xs bg-red-500/10 border border-red-500/20 text-red-500 dark:text-red-400"
      >
        {{ mcpFormError }}
      </div>

      <div v-if="mcpConnectionError" role="alert"
        class="p-2.5 rounded-xl text-xs bg-red-500/10 border border-red-500/20 text-red-500 dark:text-red-400">
        {{ mcpConnectionError }}
      </div>
      <div v-if="mcpConnectionResult" role="status"
        class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 space-y-1">
                <p>{{ t('settings.mcp.connectionSuccess', { count: mcpConnectionResult.toolCount, ms: mcpConnectionResult.elapsedMillis }) }}</p>
        <p v-if="mcpConnectionResult.toolNames.length" class="break-words">{{ mcpConnectionResult.toolNames.join(t('common.listSeparator')) }}</p>
        <p>{{ t('settings.mcp.connectionNote') }}</p>
      </div>

      <!-- 底部操作按钮 -->
      <div class="flex items-center justify-end gap-2.5 pt-3 border-t" :class="isDark ? 'border-white/10' : 'border-gray-200'">
        <button
          type="button"
          @click="cancelMcpForm"
          :class="[
            'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
            isDark
              ? 'border-white/15 hover:bg-white/5 text-zinc-300'
              : 'border-gray-200 hover:bg-gray-50 text-gray-700'
          ]"
        >
                    {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          :disabled="isConnectingMcp || isSubmittingMcp"
          :aria-busy="isConnectingMcp"
          @click="handleConnectMcp"
          class="px-4 py-1.5 rounded-xl border text-xs font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
          :class="isDark ? 'border-emerald-500/30 text-emerald-400 hover:bg-white/5' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'"
        >
          {{ isConnectingMcp ? t('settings.mcp.connecting') : t('settings.mcp.testConnection') }}
        </button>
        <button
          type="button"
          :disabled="isSubmittingMcp || isConnectingMcp"
          @click="handleSaveMcp"
          class="px-4 py-1.5 rounded-xl text-xs font-medium text-white cursor-pointer transition shadow-sm"
          :class="[
            isSubmittingMcp || isConnectingMcp ? 'bg-cyan-600/50 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-500 shadow-[0_0_15px_rgba(8,145,178,0.4)]'
          ]"
        >
                    {{ isSubmittingMcp ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
