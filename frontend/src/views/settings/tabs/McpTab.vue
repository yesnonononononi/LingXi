<script setup lang="ts">
import {computed} from 'vue';
import {useMcpTab, type McpTriState} from './useMcpTab';
import {MCP_TRANSPORTS} from '../../../types/chat';
import McpServiceCard from './McpServiceCard.vue';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import {useTheme} from '../../../composables/useTheme';
import {useI18n} from '../../../i18n';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

/** 自动健康检查三态下拉的选项（真源仍是 useMcpTab 里的 computed 双向映射）。 */
const autoHealthCheckOptions = computed(() => [
  { value: 'unset', label: t('settings.mcp.autoHealthCheckUnset') },
  { value: 'on', label: t('settings.mcp.autoHealthCheckOn') },
  { value: 'off', label: t('settings.mcp.autoHealthCheckOff') },
]);

/** 下拉回调收窄：LxSelect 的事件值是 string，三态集合由 useMcpTab 的 setter 兜底校验。 */
const setAutoHealthCheckMode = (value: string): void => {
  mcpAutoHealthCheckMode.value = value as McpTriState;
};

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
  mcpStates,
  mcpReconnecting,
  handleReconnectMcp,
  mcpToast,
  mcpForm,
  mcpAutoHealthCheckMode,
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
                    <h4 class="text-base font-bold tracking-tight text-zinc-900 dark:text-white dark:text-glow-white">
            {{ t('settings.mcp.title') }}
          </h4>
          <p class="text-xs text-lx-muted dark:text-glow-subtle mt-0.5">
            {{ t('settings.mcp.subtitle') }}
          </p>
                </div>
        <button
          type="button"
          @click="startAddMcp"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-lx-fs-sm font-medium cursor-pointer shadow-sm transition whitespace-nowrap shrink-0"
        >
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="whitespace-nowrap">{{ t('settings.mcp.add') }}</span>
        </button>
      </div>

      <!-- 加载中 -->
            <div v-if="isMcpLoading" class="py-8 text-center text-xs text-zinc-400">
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
        class="py-12 text-center text-xs text-lx-faint border border-dashed rounded-2xl"
                :class="isDark ? 'border-white/10' : 'border-zinc-200'"
      >
        {{ t('settings.mcp.empty') }}
      </div>

      <!-- 服务卡片列表：分区与操作条由 McpServiceCard + LxListCard 统一保证 -->
      <div v-else class="space-y-3">
        <McpServiceCard
          v-for="item in mcpList"
          :key="item.id"
          :item="item"
          :state="mcpStates[item.id] ?? null"
          :row-connection="mcpRowConnections[item.id] ?? null"
          :reconnecting="!!mcpReconnecting[item.id]"
          :is-dark="isDark"
          @reconnect="handleReconnectMcp"
          @toggle="handleToggleMcp"
          @edit="startEditMcp"
          @remove="handleDeleteMcp"
          @test="handleConnectSavedMcp"
        />
      </div>
    </div>

    <!-- 编辑 / 新增表单 -->
    <div v-else class="space-y-4">
      <h4 class="text-base font-bold tracking-tight text-zinc-900 dark:text-white dark:text-glow-white">
                {{ editingMcpId ? t('settings.mcp.editHeading') : t('settings.mcp.addHeading') }}
      </h4>

      <!-- 服务名称 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.nameLabel') }}</label>
        <input
          v-model="mcpForm.name"
          type="text"
          :placeholder="t('settings.mcp.namePlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 传输方式 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300 inline-flex items-center gap-1.5">
                    {{ t('settings.mcp.transportLabel') }}
          <!-- stdio 环境依赖提示：黄圈白底感叹号，hover 说明 npx/PATH 限制 -->
          <span
            v-if="mcpForm.transport === 'stdio'"
            class="inline-flex cursor-help text-amber-500"
            :title="t('settings.mcp.stdioHintTitle')"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="7" />
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
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')
            ]"
          >
            {{ t }}
          </button>
        </div>
                <p v-if="mcpForm.transport === 'stdio'" class="text-lx-fs-sm text-lx-faint">
          {{ t('settings.mcp.stdioHintText') }}
        </p>
      </div>

      <!-- 服务地址（http 系传输） -->
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-1.5">
        <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.urlLabel') }}</label>
        <input
          v-model="mcpForm.url"
          type="text"
          :placeholder="t('settings.mcp.urlPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- stdio 启动命令 -->
      <div v-if="mcpForm.transport === 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {{ t('settings.mcp.commandLabel') }}
          <span class="text-lx-faint font-normal">{{ t('settings.mcp.commandHint') }}</span>
        </label>
        <textarea
          v-model="mcpForm.commandLines"
          rows="3"
          :placeholder="t('settings.mcp.commandPlaceholder')"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition resize-none font-mono',
            isDark
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        ></textarea>
      </div>

      <!-- stdio 环境变量 -->
      <div v-if="mcpForm.transport === 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {{ t('settings.mcp.envLabel') }}
          <span class="text-lx-faint font-normal">{{ t('settings.mcp.envHint') }}</span>
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
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        ></textarea>
        <p
          v-if="mcpEnvPristine && mcpForm.envLines"
          class="text-lx-fs-sm text-lx-faint"
        >
                    {{ t('settings.mcp.envPristineHint') }}
        </p>
      </div>

      <!-- 请求头（http 系传输） -->
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-1.5">
                <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {{ t('settings.mcp.headersLabel') }}
          <span class="text-lx-faint font-normal">{{ t('settings.mcp.headersHint') }}</span>
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
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        ></textarea>
        <p
          v-if="mcpHeadersPristine && mcpForm.headerLines"
          class="text-lx-fs-sm text-lx-faint"
        >
                    {{ t('settings.mcp.headersPristineHint') }}
        </p>
      </div>

      <!-- 服务描述：随提示词下发给模型（每服务一行），由业务用户填写 -->
      <div class="space-y-1.5">
                <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {{ t('settings.mcp.descriptionLabel') }}
          <span class="text-lx-faint font-normal">{{ t('settings.mcp.descriptionHint') }}</span>
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
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 超时与输出上限 -->
      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.initTimeoutLabel') }}</label>
          <input
            v-model.number="mcpForm.initializationTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-zinc-200 text-zinc-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.execTimeoutLabel') }}</label>
          <input
            v-model.number="mcpForm.executionTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-zinc-200 text-zinc-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.maxOutputLabel') }}</label>
          <input
            v-model.number="mcpForm.maxOutput"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80'
                : 'bg-white border-zinc-200 text-zinc-800 focus:border-blue-500'
            ]"
          />
        </div>
      </div>

      <!-- 高级连接容错：4 项全部可选，留空即不下发（null），沿用库默认行为 -->
      <div
        class="space-y-3 p-3 rounded-2xl border"
        :class="isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50/60'"
      >
        <div>
          <p class="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            {{ t('settings.mcp.advancedGroup') }}
          </p>
          <p class="text-lx-fs-sm text-lx-faint mt-0.5">
            {{ t('settings.mcp.advancedGroupHint') }}
          </p>
        </div>

        <!-- 协议版本：留空 = 走协议探测 -->
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            {{ t('settings.mcp.protocolVersionLabel') }}
            <span class="text-lx-faint font-normal">{{ t('settings.mcp.protocolVersionHint') }}</span>
          </label>
          <input
            v-model="mcpForm.protocolVersion"
            type="text"
            maxlength="32"
            :placeholder="t('settings.mcp.protocolVersionPlaceholder')"
            :title="t('settings.mcp.protocolVersionTooltip')"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
              isDark
                ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
                : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
            ]"
          />
          <p class="text-lx-fs-sm text-lx-faint">{{ t('settings.mcp.protocolVersionTooltip') }}</p>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <!-- 自动健康检查：三态，才能表达「未设置，沿用库默认」 -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              {{ t('settings.mcp.autoHealthCheckLabel') }}
            </label>
            <SettingsSelect
              id="mcp-auto-health-check"
              data-testid="mcp-auto-health-check"
              :label="t('settings.mcp.autoHealthCheckLabel')"
              :title="t('settings.mcp.autoHealthCheckTooltip')"
              :model-value="mcpAutoHealthCheckMode"
              :options="autoHealthCheckOptions"
              @update:model-value="setAutoHealthCheckMode"
            />
          </div>

          <!-- 健康检查间隔(ms) -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              {{ t('settings.mcp.healthCheckIntervalLabel') }}
            </label>
            <input
              v-model.number="mcpForm.healthCheckInterval"
              type="number"
              min="1"
              step="1"
              :placeholder="t('settings.mcp.healthCheckIntervalPlaceholder')"
              :title="t('settings.mcp.healthCheckIntervalTooltip')"
              :class="[
                'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
                isDark
                  ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
                  : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
              ]"
            />
          </div>

          <!-- 重连间隔(ms) -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              {{ t('settings.mcp.reconnectIntervalLabel') }}
            </label>
            <input
              v-model.number="mcpForm.reconnectInterval"
              type="number"
              min="1"
              step="1"
              :placeholder="t('settings.mcp.reconnectIntervalPlaceholder')"
              :title="t('settings.mcp.reconnectIntervalTooltip')"
              :class="[
                'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
                isDark
                  ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-cyan-400/80'
                  : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
              ]"
            />
          </div>
        </div>

        <p class="text-lx-fs-sm text-lx-faint">
          {{ t('settings.mcp.autoHealthCheckTooltip') }}
        </p>
        <p class="text-lx-fs-sm text-lx-faint">
          {{ t('settings.mcp.intervalTooltip') }}
        </p>
      </div>

      <!-- 启用开关 -->
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input v-model="mcpForm.enabled" type="checkbox" class="w-3.5 h-3.5 cursor-pointer accent-cyan-500" />
        <span class="text-xs text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.enableService') }}</span>
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
      <div class="flex items-center justify-end gap-2.5 pt-3 border-t" :class="isDark ? 'border-white/10' : 'border-zinc-200'">
        <button
          type="button"
          @click="cancelMcpForm"
          :class="[
            'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
            isDark
              ? 'border-white/15 hover:bg-white/5 text-zinc-300'
              : 'border-zinc-200 hover:bg-zinc-50 text-zinc-700'
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
