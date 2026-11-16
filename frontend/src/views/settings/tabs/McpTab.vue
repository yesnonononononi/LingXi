<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue';
import {useMcpTab, type McpTriState} from './useMcpTab';
import {findBrowserMcpRecord, useBrowserMcp} from '../../../composables/useBrowserMcp';
import {MCP_AUTH_MODES, MCP_TRANSPORTS} from '../../../types/chat';
import McpServiceCard from './McpServiceCard.vue';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import CollapseTransition from '../../../components/common/CollapseTransition.vue';
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
  isMcpStatesLoading,
  mcpReconnecting,
  mcpAuthorizing,
  handleReconnectMcp,
  handleAuthorizeMcp,
  mcpToast,
  mcpForm,
  mcpAutoHealthCheckMode,
  mcpHeadersPristine,
  addMcpHeader,
  removeMcpHeader,
  markMcpHeadersDirty,
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

const browserMcpRecord = computed(() => findBrowserMcpRecord(mcpList.value));
const {
  supported: browserMcpSupported,
  isBusy: isBrowserMcpBusy,
  errorMsg: browserMcpError,
  serverStatus: browserMcpStatus,
  refreshStatus: refreshBrowserMcpStatus,
  enableBrowserMcp,
  disableBrowserMcp,
} = useBrowserMcp({ onChanged: loadMcp });

onMounted(() => {
  void refreshBrowserMcpStatus();
});

/** 「高级选项」折叠面板的开合状态：默认收起，主区只留必填项，避免一屏塞满选填框。 */
const isAdvancedOpen = ref(false);

/** 是否存在被折叠起来的非默认配置：用于编辑态自动展开，否则用户会以为配置丢失。 */
const hasAdvancedConfig = (): boolean => {
  const form = mcpForm.value;
  return form.protocolVersion !== ''
    || form.autoHealthCheck !== null
    || form.healthCheckInterval !== null
    || form.reconnectInterval !== null
    || form.authClientId !== ''
    || form.authScopes !== ''
    || form.authServer !== '';
};

// flush: 'post' —— startEditMcp 先填表单再翻编辑态，post 才能读到已回填的值。
watch(isEditingOrAddingMcp, (editing) => {
  isAdvancedOpen.value = editing && hasAdvancedConfig();
}, {flush: 'post'});

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

      <!-- 内置浏览器可选本地 MCP 能力开关（仅 Electron 桌面端） -->
      <div
        v-if="browserMcpSupported"
        class="p-3.5 rounded-2xl border transition-all space-y-2"
        :class="isDark ? 'bg-white/[0.03] border-white/10' : 'bg-zinc-50/70 border-zinc-200/80'"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-xs font-semibold text-zinc-900 dark:text-white">{{ t('settings.mcp.browserMcpTitle') }}</span>
              <span
                class="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                :class="browserMcpRecord && browserMcpStatus?.running
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-zinc-500/15 text-lx-muted'"
              >
                {{ browserMcpRecord && browserMcpStatus?.running ? t('settings.mcp.browserMcpActive') : t('settings.mcp.browserMcpInactive') }}
              </span>
            </div>
            <p class="text-xs text-lx-muted mt-1 leading-relaxed">
              {{ t('settings.mcp.browserMcpDesc') }}
            </p>
          </div>
          <button
            v-if="!browserMcpRecord"
            type="button"
            :disabled="isBrowserMcpBusy"
            @click="enableBrowserMcp()"
            class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium cursor-pointer shrink-0 transition"
          >
            {{ isBrowserMcpBusy ? t('settings.mcp.browserMcpEnabling') : t('settings.mcp.browserMcpEnable') }}
          </button>
          <button
            v-else
            type="button"
            :disabled="isBrowserMcpBusy"
            @click="disableBrowserMcp(browserMcpRecord)"
            class="px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer shrink-0 transition disabled:opacity-50"
            :class="isDark ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-red-200 text-red-600 hover:bg-red-50'"
          >
            {{ isBrowserMcpBusy ? t('settings.mcp.browserMcpDisabling') : t('settings.mcp.browserMcpDisable') }}
          </button>
        </div>
        <p v-if="browserMcpError" class="text-xs text-red-400">{{ browserMcpError }}</p>
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
          :states-loading="isMcpStatesLoading"
          :row-connection="mcpRowConnections[item.id] ?? null"
          :reconnecting="!!mcpReconnecting[item.id]"
          :authorizing="!!mcpAuthorizing[item.id]"
          :is-dark="isDark"
          @reconnect="handleReconnectMcp"
          @authorize="handleAuthorizeMcp"
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
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
                ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_12px_rgba(37,99,235,0.4)]'
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
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            {{ t('settings.mcp.headersLabel') }}
            <span class="text-lx-faint font-normal">{{ t('settings.mcp.headersHint') }}</span>
          </label>
          <button
            type="button"
            @click="addMcpHeader"
            :class="[
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-lx-fs-sm font-medium transition cursor-pointer shrink-0',
              isDark
                ? 'border-white/15 text-zinc-300 hover:bg-white/5'
                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            ]"
          >
            <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>{{ t('settings.mcp.addHeader') }}</span>
          </button>
        </div>

        <div v-if="mcpForm.headerItems.length === 0" class="px-3 py-2.5 rounded-xl border border-dashed text-lx-fs-sm text-lx-faint" :class="isDark ? 'border-white/10' : 'border-zinc-200'">
          {{ t('settings.mcp.headersEmptyHint') }}
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="(header, index) in mcpForm.headerItems"
            :key="index"
            class="flex items-center gap-2"
          >
            <input
              v-model="header.key"
              @input="markMcpHeadersDirty"
              type="text"
              :placeholder="t('settings.mcp.headerKeyPlaceholder')"
              :class="[
                'flex-1 min-w-0 px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
                isDark
                  ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                  : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
              ]"
            />
            <span class="text-xs font-mono text-lx-faint shrink-0 select-none">:</span>
            <input
              v-model="header.value"
              @input="markMcpHeadersDirty"
              type="text"
              :placeholder="t('settings.mcp.headerValuePlaceholder')"
              :class="[
                'flex-[1.4] min-w-0 px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
                isDark
                  ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                  : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
              ]"
            />
            <button
              type="button"
              @click="removeMcpHeader(index)"
              :aria-label="t('settings.mcp.removeHeader')"
              :title="t('settings.mcp.removeHeader')"
              :class="[
                'p-2 rounded-xl border transition cursor-pointer shrink-0',
                isDark
                  ? 'border-white/10 text-zinc-400 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10'
                  : 'border-zinc-200 text-zinc-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50'
              ]"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <p
          v-if="mcpHeadersPristine && mcpForm.headerItems.some((item) => item.key.trim() || item.value.trim())"
          class="text-lx-fs-sm text-lx-faint"
        >
          {{ t('settings.mcp.headersPristineHint') }}
        </p>
      </div>

      <!-- 认证方式（http 系传输）：静态凭据走请求头，OAuth 走浏览器授权 -->
      <div v-if="mcpForm.transport !== 'stdio'" class="space-y-1.5">
        <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.authLabel') }}</label>
        <div class="flex items-center gap-2">
          <button
            v-for="mode in MCP_AUTH_MODES"
            :key="mode"
            type="button"
            @click="mcpForm.authMode = mode"
            :class="[
              'px-3 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
              mcpForm.authMode === mode
                ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_12px_rgba(37,99,235,0.4)]'
                : (isDark
                    ? 'border-white/15 text-zinc-300 hover:bg-white/5'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')
            ]"
          >
            {{ mode === 'oauth' ? t('settings.mcp.authModeOAuth') : t('settings.mcp.authModeNone') }}
          </button>
        </div>
        <p class="text-lx-fs-sm text-lx-faint">{{ t('settings.mcp.authHint') }}</p>
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
              ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
              : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!--
        高级选项：可留空、有默认值的配置全收在这里，主区只留必填项。
        展开区自己滚动（max-h + overflow-y-auto），避免把底部保存按钮顶出视口。
      -->
      <div
        class="rounded-2xl border"
        :class="isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50/60'"
      >
        <button
          type="button"
          :aria-expanded="isAdvancedOpen"
          @click="isAdvancedOpen = !isAdvancedOpen"
          class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-2xl cursor-pointer text-left"
        >
          <span class="flex items-baseline gap-1.5 min-w-0">
            <span class="text-xs font-semibold text-zinc-800 dark:text-zinc-200 shrink-0">
              {{ t('settings.mcp.advancedOptionsTitle') }}
            </span>
            <span class="text-lx-fs-sm text-lx-faint truncate">
              {{ t('settings.mcp.advancedOptionsHint') }}
            </span>
          </span>
          <svg
            class="w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform duration-200"
            :class="isAdvancedOpen ? 'rotate-180' : ''"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <CollapseTransition>
          <div v-if="isAdvancedOpen" class="px-3 pb-3">
            <div class="max-h-[340px] overflow-y-auto space-y-3 pr-1">
              <!-- OAuth 细节：三项都可留空，由服务端发现 -->
              <div v-if="mcpForm.transport !== 'stdio' && mcpForm.authMode === 'oauth'" class="grid grid-cols-2 gap-3">
                <div class="space-y-1.5">
                  <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.authClientIdLabel') }}</label>
                  <input
                    v-model="mcpForm.authClientId"
                    type="text"
                    :placeholder="t('settings.mcp.authClientIdPlaceholder')"
                    :class="[
                      'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
                      isDark
                        ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                        : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
                    ]"
                  />
                </div>
                <div class="space-y-1.5">
                  <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.authScopesLabel') }}</label>
                  <input
                    v-model="mcpForm.authScopes"
                    type="text"
                    :placeholder="t('settings.mcp.authScopesPlaceholder')"
                    :class="[
                      'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
                      isDark
                        ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                        : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
                    ]"
                  />
                </div>
                <div class="col-span-2 space-y-1.5">
                  <label class="text-xs font-medium text-zinc-700 dark:text-zinc-300">{{ t('settings.mcp.authServerLabel') }}</label>
                  <input
                    v-model="mcpForm.authServer"
                    type="text"
                    :placeholder="t('settings.mcp.authServerPlaceholder')"
                    :class="[
                      'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
                      isDark
                        ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                        : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
                    ]"
                  />
                </div>
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
                        ? 'bg-black/90 border-white/15 text-white focus:border-blue-400/80'
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
                        ? 'bg-black/90 border-white/15 text-white focus:border-blue-400/80'
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
                        ? 'bg-black/90 border-white/15 text-white focus:border-blue-400/80'
                        : 'bg-white border-zinc-200 text-zinc-800 focus:border-blue-500'
                    ]"
                  />
                </div>
              </div>

              <!-- 高级连接容错：4 项全部可选，留空即不下发（null），沿用库默认行为 -->
              <div class="space-y-3 pt-1">
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
                        ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
                        : 'bg-white border-zinc-200 text-zinc-800 placeholder-zinc-400 focus:border-blue-500'
                    ]"
                  />
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
                          ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
                          ? 'bg-black/90 border-white/15 text-white placeholder-zinc-500 focus:border-blue-400/80'
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
            </div>
          </div>
        </CollapseTransition>
      </div>

      <!-- 启用开关 -->
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input v-model="mcpForm.enabled" type="checkbox" class="w-3.5 h-3.5 cursor-pointer accent-blue-500" />
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
            isSubmittingMcp || isConnectingMcp ? 'bg-blue-600/50 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_15px_rgba(37,99,235,0.4)]'
          ]"
        >
                    {{ isSubmittingMcp ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
