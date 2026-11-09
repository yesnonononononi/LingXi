<script setup lang="ts">
import {computed} from 'vue';
import LxListCard from '../../../components/common/LxListCard.vue';
import {actionClass, chipClass} from '../../../utils/listCardTone';
import type {McpConnectionStateVO, McpVO} from '../../../types/chat';
import {useI18n} from '../../../i18n';

/**
 * 单个 MCP 服务卡片。
 *
 * 从 McpTab 里拆出来的理由：列表卡片和编辑表单挤在一个 686 行的 SFC 里，
 * 改卡片布局要在一堆表单控件中间找位置，而且卡片是「纯展示 + 冒事件」的叶子，
 * 没有生命周期与请求逻辑，独立成组件后可以单独编译与断言。
 *
 * 展示契约：
 * - **状态唯一**：一张卡只有一个状态徽标（停用 / 运行中·N 个工具 / 连接失败 / 未连接）。
 *   「已启用」与「运行中」原本是两个并列徽标，语义重叠 —— 能跑就是启用，跑不了就是没启用，
 *   分开展示只会让用户在「已启用 + 未连接」这种组合里自己脑补。
 * - 配置事实（传输方式、请求头数、超时）统一走灰阶元信息行，彩色只留给实时状态。
 * - 操作按钮一律落在卡片操作条，由 LxListCard 保证独立成行右对齐。
 */
const props = withDefaults(
  defineProps<{
    item: McpVO;
    /** 共享连接表的实时状态；停用服务不会有状态行 */
    state?: McpConnectionStateVO | null;
    /** 本行「测试连接」按钮的独立状态 */
    rowConnection?: { loading?: boolean; success?: boolean; error?: string | null } | null;
    /** 「重新连接」进行中 */
    reconnecting?: boolean;
    isDark?: boolean;
  }>(),
  {state: null, rowConnection: null, reconnecting: false}
);

const emit = defineEmits<{
  reconnect: [McpVO];
  toggle: [McpVO];
  edit: [McpVO];
  remove: [McpVO];
  test: [McpVO];
}>();

const {t} = useI18n();

/** 状态机：停用优先（配置态），否则按连接表（运行态）。 */
const statusKind = computed<'DISABLED' | 'CONNECTED' | 'FAILED' | 'DISCONNECTED'>(() => {
  if (props.item.status === 0) return 'DISABLED';
  if (props.state?.state === 'CONNECTED') return 'CONNECTED';
  if (props.state?.state === 'FAILED') return 'FAILED';
  return 'DISCONNECTED';
});

const statusTone = computed(() => {
  switch (statusKind.value) {
    case 'CONNECTED': return 'ok' as const;
    case 'FAILED': return 'danger' as const;
    case 'DISABLED': return 'muted' as const;
    default: return 'warn' as const;
  }
});

const statusLabel = computed(() => {
  switch (statusKind.value) {
    case 'CONNECTED': return t('settings.mcp.stateConnected', {count: props.state?.toolCount ?? 0});
    case 'FAILED': return t('settings.mcp.stateFailed');
    case 'DISABLED': return t('settings.mcp.disabled');
    default: return t('settings.mcp.stateDisconnected');
  }
});

/** http 系显示端点，stdio 显示启动命令。 */
const connectionLabel = computed(() => (
  props.item.transport === 'stdio' ? (props.item.command || []).join(' ') : props.item.url || ''
));

const countHeaders = () => Object.keys(props.item.headers || {}).length;
const countEnvVars = () => Object.keys(props.item.env || {}).length;

/** 元信息顺序固定：请求头 → 环境变量 → 执行超时 → 输出上限，只列非空项。 */
const meta = computed(() => {
  const list: string[] = [];
  const headers = countHeaders();
  const env = countEnvVars();
  if (headers > 0) list.push(t('settings.mcp.headersCount', {count: headers}));
  if (env > 0) list.push(t('settings.mcp.envCount', {count: env}));
  if (props.item.executionTimeout) {
    list.push(t('settings.mcp.timeoutSeconds', {seconds: Math.round(props.item.executionTimeout / 1000)}));
  }
  if (props.item.maxOutput) list.push(t('settings.mcp.maxOutputValue', {value: props.item.maxOutput}));
  return list;
});

const failureReason = computed(() => (
  statusKind.value === 'FAILED' ? props.state?.error ?? '' : ''
));
</script>

<template>
  <LxListCard :is-dark="isDark" data-testid="mcp-service-card">
    <template #header>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          class="min-w-0 max-w-full truncate text-sm font-semibold text-zinc-900 dark:text-white dark:text-glow-subtle"
          :title="item.name"
        >
          {{ item.name }}
        </span>
        <span data-testid="mcp-connection-state" :class="chipClass(statusTone)">
          <span
            v-if="statusKind !== 'DISABLED'"
            class="h-1.5 w-1.5 rounded-full bg-current"
            aria-hidden="true"
          ></span>
          {{ statusLabel }}
        </span>
      </div>
    </template>

    <!-- 服务描述：随提示词下发给模型，供模型判断相关性 -->
    <p v-if="item.description" class="mt-1.5 text-xs leading-relaxed text-lx-tertiary line-clamp-2 break-words">
      {{ item.description }}
    </p>

    <!-- 端点 / 启动命令：单行省略 + tooltip，长地址不把卡片撑高 -->
    <p class="mt-1 truncate font-mono text-xs text-lx-muted" :title="connectionLabel">
      {{ connectionLabel }}
    </p>

    <!-- 元信息行：传输方式作为事实标签，其余只读参数统一灰阶、「·」分隔 -->
    <div class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-lx-fs-sm text-lx-faint">
      <span :class="chipClass('muted')">{{ item.transport || 'streamable-http' }}</span>
      <!-- stdio 环境依赖提示：悬停说明 npx/PATH 限制（描边图标，深浅主题都不刺眼） -->
      <span
        v-if="item.transport === 'stdio'"
        class="inline-flex shrink-0 cursor-help text-amber-500"
        :title="t('settings.mcp.stdioHintTitle')"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="8" cy="8" r="7" />
          <path stroke-linecap="round" d="M8 4.6v4.2" />
          <circle cx="8" cy="11.4" r="0.85" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <template v-for="(entry, index) in meta" :key="entry">
        <span v-if="index > 0" aria-hidden="true" class="opacity-40">·</span>
        <span class="whitespace-nowrap">{{ entry }}</span>
      </template>
    </div>

    <!-- 错误区：浅底红灯，长文本允许任意断行 -->
    <p
      v-if="failureReason"
      class="mt-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-xs leading-relaxed text-red-500 break-all dark:text-red-400"
    >{{ t('settings.mcp.stateFailedReason', {reason: failureReason}) }}</p>
    <p
      v-if="rowConnection?.error"
      role="alert"
      class="mt-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-xs leading-relaxed text-red-500 break-all dark:text-red-400"
    >{{ rowConnection.error }}</p>

    <template #actions>
      <button
        v-if="item.status !== 0"
        type="button"
        data-testid="mcp-reconnect"
        :disabled="reconnecting"
        :aria-busy="reconnecting || false"
        @click="emit('reconnect', item)"
        :class="actionClass('warn')"
      >
        <span v-if="reconnecting" class="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true"></span>
        {{ reconnecting ? t('settings.mcp.reconnecting') : t('settings.mcp.reconnect') }}
      </button>
      <button
        type="button"
        @click="emit('toggle', item)"
        :class="actionClass('muted')"
      >
        {{ item.status === 0 ? t('settings.mcp.enable') : t('settings.mcp.disable') }}
      </button>
      <button
        type="button"
        @click="emit('edit', item)"
        :class="actionClass('accent')"
      >
        {{ t('common.edit') }}
      </button>
      <button
        type="button"
        @click="emit('remove', item)"
        :class="actionClass('danger')"
      >
        {{ t('common.remove') }}
      </button>
      <button
        type="button"
        :disabled="rowConnection?.loading"
        :aria-busy="rowConnection?.loading || false"
        @click="emit('test', item)"
        :class="actionClass('primary')"
      >
        <span v-if="rowConnection?.loading" class="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true"></span>
        {{ rowConnection?.loading ? t('settings.mcp.connecting') : rowConnection?.success ? t('settings.mcp.connected') : t('settings.mcp.testConnection') }}
      </button>
    </template>
  </LxListCard>
</template>
