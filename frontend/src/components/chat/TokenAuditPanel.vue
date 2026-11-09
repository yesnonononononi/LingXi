<script setup lang="ts">
/**
 * 用量审计浮动面板。
 *
 * <p>右侧浮动抽屉，展示一次「上下文快照」口径的 token 构成：当前上下文占用、
 * 消息构成（系统 / 用户 / 模型 / 工具返回）、工具来源二级拆解，以及其他消息（请求开销）。</p>
 *
 * <p><b>数据来源两条，解析/渲染只有一条</b>：</p>
 * <ol>
 *   <li>打开面板（或切换会话）通过 {@link TokenAuditAPI} 读取已存快照，只读、不触发重算；</li>
 *   <li>会话级流上的 `token_audit_snapshot` 推送（与 GET 的 `data` 完全同构，见
 *       {@link module:views/chat/tokenAuditStream}）。</li>
 * </ol>
 * <p>两条来源都先过 {@link normalizeTokenAuditSnapshot}，之后共用同一套派生函数与模板 ——
 * <b>不存在第二份渲染逻辑</b>。展示源选择规则见 {@link resolveDisplayedSnapshot}：推送优先，
 * 无推送时展示接口返回。</p>
 *
 * <p><b>没有「刷新重算」按钮</b>（2026-11-09 移除）：后端重算用的是最近一条执行的检查点，
 * 而终态采集用的就是同一份检查点 —— 重算必然得到同一结果，唯一变化是采集时刻。留着按钮
 * 等于承诺「点一下能看到新构成」，实际做不到；执行中还会用半成品覆盖完整快照。
 * 分项的新鲜度由终态采集 + SSE 推送负责，面板只做展示。</p>
 *
 * <p><b>渲染铁律</b>（做错就是 bug，与后端契约同步变更时必须重新核对）：</p>
 * <ol>
 *   <li>「N 项」一律取数组/契约字段：类别数取存在的分组个数、工具项数取 `items.length`、
 *       其他消息项数取 `requestOverhead.itemCount`。调用次数已从契约移除，任何位置都不参与计数。</li>
 *   <li>`null`/`undefined` = 「不知道」，不等于 0：字段缺失就整行不渲染，不画 0% 空进度条。</li>
 *   <li>数值与百分比全部消费后端字段，前端不做除法/减法；仅把 ratio 乘 100 转百分数文本、
 *       以及直接拿 ratio 当进度条宽度。</li>
 * </ol>
 *
 * <p><b>样式</b>：整块只用 `--lx-*` 语义令牌（等价于明暗两套取值），零调色板硬编码 ——
 * 因此不改 `tokens.css`、不新增令牌，也不触碰主题残余基线。</p>
 */
import {computed, ref, watch} from 'vue';
import {t} from '../../i18n';
import {isOk} from '../../utils/api';
import {ApiError, describeKind} from '../../services/interceptor';
import {TokenAuditAPI} from '../../services/tokenAudit';
import type {SessionTokenAuditSnapshot, TokenAuditCategoryType} from '../../types/tokenAudit';
import {
  formatBarWidth,
  formatCapturedAt,
  formatRatioPercent,
  formatTokenAmount,
  formatTokenLimit,
  hasContextSection,
  hasOverheadSection,
  resolveSnapshotDrift,
  resolveContextSummary,
  resolveMessageRows,
  resolveOverheadSummary,
  resolveToolDefinitionRows,
  resolveToolGroupRows,
  countToolGroupKinds,
  resolveOrdinaryToolRows,
} from '../../views/chat/tokenAuditPresentation';
import {
  clearTokenAuditStreamEntry,
  getTokenAuditStreamEntry,
  normalizeTokenAuditSnapshot,
  resolveDisplayedSnapshot,
} from '../../views/chat/tokenAuditStream';

const props = defineProps<{
  /** 是否展开（`v-model:open`）。 */
  open: boolean;
  /** 目标会话 ID；缺失时面板只给一行提示，不发请求。 */
  sessionId?: number | string | null;
  executing?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

/** 用户消息和附件沿用同一色系。 */
const CATEGORY_DOT_CLASS: Readonly<Record<TokenAuditCategoryType, string>> = {
  SYSTEM: 'bg-lx-muted',
  USER: 'bg-lx-accent',
  ATTACHMENT: 'bg-lx-accent',
  AI: 'bg-lx-success',
  TOOL: 'bg-lx-primary',
};

/** 最近一次接口返回的快照。 */
const fetched = ref<SessionTokenAuditSnapshot | null>(null);
/** 是否正在请求。 */
const loading = ref(false);
/** 请求失败的用户可见文案；空串表示无错误。 */
const errorMessage = ref('');
/** 竞态令牌：只有最后一次请求的响应会被采用。 */
let requestSeq = 0;

/** 会话 ID 是否可用。 */
const canLoad = computed<boolean>(() => {
  const id = props.sessionId;
  return id !== null && id !== undefined && String(id).trim() !== '';
});

/**
 * 该会话最近一次流推送（响应式：读的是模块级 Map，推送一到就重算）。
 *
 * <p>注意键用**面板当前会话**的 id：后端按根会话推送，而 ChatView 传进来的正是它订阅的会话，
 * 二者一致；看子会话时事件落根流，面板也挂在根会话上下文里。</p>
 */
const streamEntry = computed(() => (canLoad.value ? getTokenAuditStreamEntry(props.sessionId) : null));

/**
 * 实际渲染的快照：推送优先，无推送回退 GET（规则唯一实现在
 * {@link resolveDisplayedSnapshot}，组件不自作判断）。
 */
const displayed = computed<SessionTokenAuditSnapshot | null>(() =>
  resolveDisplayedSnapshot(streamEntry.value, fetched.value)
);

/** 当前展示的数据是否来自流推送 —— 仅用于头部的「实时」角标，不影响任何数值。 */
const isStreamDriven = computed<boolean>(() => streamEntry.value !== null);

/** 「工具返回消息」二级拆解是否展开。 */
const toolRowExpanded = ref(false);
/** 「其他消息」二级拆解是否展开。 */
const overheadExpanded = ref(false);
/** 采集状态；无数据时按「未采集」处理，绝不臆造 COLLECTED。 */
const displayState = computed<string>(() => displayed.value?.displayState ?? 'NOT_COLLECTED');
const isFailed = computed<boolean>(() => displayState.value === 'FAILED');
const isNotCollected = computed<boolean>(() => displayState.value === 'NOT_COLLECTED');
/** 两种已采集状态都展示快照分项，差额只说明取样不同。 */
const showBreakdown = computed<boolean>(
  () => displayState.value === 'COLLECTED' || displayState.value === 'CAPTURING'
);

const contextSummary = computed(() => resolveContextSummary(displayed.value));
const showContext = computed<boolean>(() => hasContextSection(displayed.value));

const messageRows = computed(() => resolveMessageRows(displayed.value?.messages));
const toolGroupRows = computed(() => resolveToolGroupRows(displayed.value?.tools));
const ordinaryToolRows = computed(() => resolveOrdinaryToolRows(displayed.value?.tools));
const toolKindCount = computed<number>(() => countToolGroupKinds(displayed.value?.tools));
const capturedAtText = computed<string>(() => formatCapturedAt(displayed.value?.capturedAt));
const snapshotDriftText = computed(() => {
  const drift = resolveSnapshotDrift(displayed.value);
  if (drift === null) return null;
  const label = drift > 0 ? 'chat.tokenAudit.contextAboveSnapshot' : 'chat.tokenAudit.contextBelowSnapshot';
  return t(label, {tokens: formatTokenAmount(Math.abs(drift))});
});

const showOverhead = computed<boolean>(() => hasOverheadSection(displayed.value?.requestOverhead));
const definitionRows = computed(() => resolveToolDefinitionRows(displayed.value?.requestOverhead));
const overheadSummary = computed(() => resolveOverheadSummary(displayed.value?.requestOverhead));
const overheadItemCount = computed<number | null>(() => {
  const count = displayed.value?.requestOverhead?.itemCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
});

/** FAILED 态的失败原因文案；后端未给原因时也不留空行。 */
const failText = computed<string>(() => {
  const reason = displayed.value?.failReason;
  const text = reason !== null && reason !== undefined ? String(reason).trim() : '';
  return text === '' ? t('chat.tokenAudit.failedFallback') : t('chat.tokenAudit.failed', {reason: text});
});

/** 重置全部展开态（切换会话时必须回到默认收起的干净状态）。 */
const resetExpansion = (): void => {
  toolRowExpanded.value = false;
  overheadExpanded.value = false;
};

/**
 * 读取会话快照（只读）。失败时保留上一份已展示的数据，只挂错误提示。
 *
 * <p>没有「重算」模式：分项是执行终态采集的事实，后端也只剩 GET 一个端点 ——
 * 前端若还留着重算分支，就是给自己造一条永远会 404 的路。</p>
 */
const load = async (): Promise<void> => {
  if (!canLoad.value) return;
  const sessionId = props.sessionId;
  const previousStreamEntry = streamEntry.value;
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = '';
  try {
    const res = await TokenAuditAPI.tokenAudit(sessionId);
    if (seq !== requestSeq) return;
    if (!isOk(res?.code)) {
      errorMessage.value = describeKind('business');
      return;
    }
    const snapshot = normalizeTokenAuditSnapshot(res.data, sessionId);
    if (!snapshot) return;
    fetched.value = snapshot;
    // 请求期间收到的推送可能已经包含更新的执行结果。
    if (streamEntry.value === previousStreamEntry) clearTokenAuditStreamEntry(sessionId);
    // 数据换了，旧的展开态不再适用。
    resetExpansion();
  } catch (error) {
    if (seq !== requestSeq) return;
    errorMessage.value = error instanceof ApiError
      ? describeKind(error.kind)
      : t('chat.tokenAudit.loadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
};

/** 收起面板：唯一出口是 `v-model:open`，重新打开靠 ChatView 入口行的按钮。 */
const close = (): void => {
  emit('update:open', false);
};

/** 切换「工具返回消息」二级拆解。 */
const toggleToolRow = (): void => {
  toolRowExpanded.value = !toolRowExpanded.value;
};

/** 切换「其他消息」二级拆解。 */
const toggleOverhead = (): void => {
  overheadExpanded.value = !overheadExpanded.value;
};

/** 文本形式的占比；空串表示「不知道」，模板据此不渲染该列。 */
const ratioText = (ratio?: number | null): string => formatRatioPercent(ratio);

/** 进度条宽度；null 表示不画进度条（避免 0% 假空条）。 */
const barWidth = (ratio?: number | null): string | null => formatBarWidth(ratio);

// 打开就拉一次；切换会话时先清空再按需重拉（关闭状态下不请求，省一次往返）。
// 流推送无需订阅/退订：存储是模块级单例，推送由 useChatView 在会话级流上统一落库，
// 这里只读（不新增连接、也不因面板开关而改变流的行为）。
watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  {immediate: true}
);

watch(
  () => props.sessionId,
  () => {
    requestSeq++;
    loading.value = false;
    fetched.value = null;
    errorMessage.value = '';
    resetExpansion();
    if (props.open) void load();
  }
);
</script>

<template>
  <Transition name="token-audit-slide">
    <aside
      v-if="open"
      data-testid="token-audit-panel"
      role="region"
      :aria-label="t('chat.tokenAudit.title')"
      class="absolute right-4 top-12 z-30 flex max-h-[calc(100%-4rem)] w-[300px] flex-col overflow-hidden rounded-lx-lg border border-lx-border bg-lx-surface-elevated shadow-lx-3 backdrop-blur-lx-panel"
    >
      <!-- 头部：标题 + 刷新 + 收起 -->
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-lx-border-subtle px-3 py-2">
        <h3 class="flex items-center gap-1.5 text-lx-fs-md font-semibold text-lx-primary">
          <svg class="h-3.5 w-3.5 text-lx-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 19V5m0 14h16M8 15V9m4 6V6m4 9v-4" />
          </svg>
          <span>{{ t('chat.tokenAudit.title') }}</span>
          <!-- 数据来自流推送时给个角标：用户能分清「这是刚推来的」还是「打开时取的那份」 -->
          <span
            v-if="isStreamDriven"
            data-testid="token-audit-live"
            class="flex items-center gap-1 rounded-lx-full border border-lx-border-subtle bg-lx-success-soft px-1.5 py-0.5 text-lx-fs-2xs font-normal text-lx-success"
          >
            <span class="inline-block h-1 w-1 rounded-lx-full bg-lx-success"></span>
            {{ t('chat.tokenAudit.live') }}
          </span>
        </h3>
        <div class="flex items-center gap-1">
          <button
            type="button"
            data-testid="token-audit-collapse"
            :title="t('chat.tokenAudit.collapse')"
            :aria-label="t('chat.tokenAudit.collapse')"
            class="rounded-lx-sm p-1 text-lx-muted transition hover:bg-lx-surface-hover hover:text-lx-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-lx-border-focus"
            @click="close"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <!-- 内容区：浮层内部独立滚动 -->
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        <!-- 刷新失败时保留上一份已展示的快照。 -->
        <div
          v-if="errorMessage"
          data-testid="token-audit-error"
          class="space-y-2 rounded-lx-md border border-lx-danger-border bg-lx-danger-soft px-2.5 py-2 text-lx-fs-sm text-lx-danger"
        >
          <p class="leading-relaxed">{{ errorMessage }}</p>
          <button
            type="button"
            :disabled="loading || !canLoad"
            class="rounded-lx-sm border border-lx-danger-border px-2 py-0.5 text-lx-fs-xs font-medium transition hover:bg-lx-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            @click="load()"
          >{{ t('chat.tokenAudit.retry') }}</button>
        </div>

        <template v-if="!errorMessage || displayed">
          <!-- 无会话：一行提示，不发请求 -->
          <p v-if="!canLoad" class="text-lx-fs-sm text-lx-muted">{{ t('chat.tokenAudit.noSession') }}</p>

          <template v-else>
            <!-- 首次加载占位（有数据时的刷新走头部转圈，不闪内容） -->
            <p v-if="loading && !displayed" class="text-lx-fs-sm text-lx-muted">{{ t('chat.tokenAudit.loading') }}</p>

            <!-- 1. 当前上下文：任何状态都保留（后端有实时数据才渲染） -->
            <section v-if="showContext" data-testid="token-audit-context" class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <span class="text-lx-fs-sm font-semibold text-lx-primary">{{ t('chat.tokenAudit.currentContext') }}</span>
                <span v-if="contextSummary.ratioPercent" class="font-mono text-lx-fs-sm font-semibold text-lx-primary">
                  {{ contextSummary.ratioPercent }}
                </span>
              </div>
              <div v-if="contextSummary.usedTokens !== null" class="flex items-baseline font-mono text-lx-fs-md text-lx-primary">
                <span>{{ formatTokenAmount(contextSummary.usedTokens) }}</span>
                <span v-if="contextSummary.maxTokens !== null" class="text-lx-muted">
                  &nbsp;/ {{ formatTokenLimit(contextSummary.maxTokens) }}
                </span>
              </div>
              <div
                v-if="contextSummary.barWidth"
                class="h-1 w-full overflow-hidden rounded-lx-full bg-lx-surface-active"
                :title="contextSummary.ratioPercent ?? undefined"
              >
                <div class="h-full rounded-lx-full bg-lx-accent" :style="{width: contextSummary.barWidth}"></div>
              </div>
              <!-- 刻度只标「0」与上限：中点数值需要前端做除法，违反渲染铁律 3。
                   上限用简写（`200k`），与「已用 / 上限」同一形态。 -->
              <div v-if="contextSummary.maxTokens !== null" class="flex items-center justify-between font-mono text-lx-fs-2xs text-lx-faint">
                <span>0</span>
                <span>{{ formatTokenLimit(contextSummary.maxTokens) }} {{ t('chat.tokenAudit.tokenUnit') }}</span>
              </div>
              <div v-if="contextSummary.remainingTokens !== null" class="flex items-center justify-between gap-2 text-lx-fs-xs">
                <span class="text-lx-muted">{{ t('chat.tokenAudit.remaining') }}</span>
                <span class="font-mono text-lx-secondary">
                  {{ formatTokenAmount(contextSummary.remainingTokens) }} {{ t('chat.tokenAudit.tokenUnit') }}<span
                    v-if="contextSummary.remainingPercent"
                    class="text-lx-faint"
                  > · {{ contextSummary.remainingPercent }}</span>
                </span>
              </div>
            </section>

            <!-- 未采集：只给一行说明，绝不画空分项 -->
            <p v-if="isNotCollected" data-testid="token-audit-not-collected" class="text-lx-fs-sm text-lx-muted">
              {{ t('chat.tokenAudit.notCollected') }}
            </p>

            <!-- 采集失败：保留当前上下文，附失败原因 -->
            <p
              v-else-if="isFailed"
              data-testid="token-audit-failed"
              class="rounded-lx-md border border-lx-danger-border bg-lx-danger-soft px-2.5 py-1.5 text-lx-fs-sm leading-relaxed text-lx-danger"
            >{{ failText }}</p>

            <!-- 2. 消息构成 -->
            <section
              v-if="showBreakdown && messageRows.length"
              data-testid="token-audit-messages"
              class="space-y-2 border-t border-lx-border-subtle pt-2.5"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="shrink-0 text-lx-fs-md font-semibold text-lx-primary">{{ t('chat.tokenAudit.messageComposition') }}</span>
                  <!-- 分母口径写在这里：框架 DocumentElement.ratio 一律除上下文上限，
                       不写的话「分项加起来 ≠ 顶部当前上下文占比」永远是个谜 -->
                  <span
                    data-testid="token-audit-ratio-scope"
                    class="shrink-0 text-lx-fs-2xs text-lx-faint"
                  >{{ t('chat.tokenAudit.ratioScope') }}</span>
                  <span
                    v-if="snapshotDriftText !== null"
                    data-testid="token-audit-capturing"
                    class="truncate text-lx-fs-2xs text-lx-muted"
                  >{{ snapshotDriftText }}</span>
                </div>
              </div>
              <p v-if="executing" data-testid="token-audit-executing" class="text-lx-fs-2xs text-lx-muted">
                {{ t('chat.tokenAudit.executionInProgress') }}
              </p>
              <p v-if="capturedAtText" class="text-right font-mono text-lx-fs-2xs text-lx-faint">
                {{ t('chat.tokenAudit.capturedAt', {time: capturedAtText}) }}
              </p>

              <div class="space-y-2.5">
                <div v-for="row in messageRows" :key="row.type" class="space-y-1">
                  <div class="flex items-center justify-between gap-2">
                    <!-- 工具返回消息：可展开二级拆解 -->
                    <button
                      v-if="row.type === 'TOOL' && toolKindCount > 0"
                      type="button"
                      data-testid="token-audit-tool-row"
                      :aria-expanded="toolRowExpanded"
                      class="flex min-w-0 items-center gap-1 text-left"
                      @click="toggleToolRow"
                    >
                      <span :class="['inline-block h-1.5 w-1.5 shrink-0 rounded-lx-full', CATEGORY_DOT_CLASS[row.type]]"></span>
                      <span class="shrink-0 text-lx-fs-sm font-medium text-lx-primary">{{ t(row.labelKey) }}</span>
                      <span class="shrink-0 rounded border border-lx-border-subtle bg-lx-surface-active px-1 text-lx-fs-2xs text-lx-muted">
                        {{ t('chat.tokenAudit.groupKindCount', {count: toolKindCount}) }}
                      </span>
                      <svg
                        class="h-2.5 w-2.5 shrink-0 text-lx-faint transition-transform"
                        :class="toolRowExpanded ? 'rotate-180' : ''"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <div v-else class="flex min-w-0 items-center gap-1">
                      <span :class="['inline-block h-1.5 w-1.5 shrink-0 rounded-lx-full', CATEGORY_DOT_CLASS[row.type]]"></span>
                      <span class="truncate text-lx-fs-sm text-lx-secondary">{{ t(row.labelKey) }}</span>
                    </div>
                    <div class="flex shrink-0 items-center gap-2 font-mono">
                      <span class="text-lx-fs-sm font-medium text-lx-primary">
                        {{ formatTokenAmount(row.tokens) }}<span class="text-lx-fs-2xs text-lx-faint"> {{ t('chat.tokenAudit.tokenUnit') }}</span>
                      </span>
                      <span v-if="ratioText(row.ratio)" class="w-9 text-right text-lx-fs-xs text-lx-faint">
                        {{ ratioText(row.ratio) }}
                      </span>
                    </div>
                  </div>
                  <div v-if="barWidth(row.ratio)" class="h-1 w-full overflow-hidden rounded-lx-full bg-lx-surface-active">
                    <div
                      :class="['h-full rounded-lx-full', CATEGORY_DOT_CLASS[row.type]]"
                      :style="{width: barWidth(row.ratio) ?? '0%'}"
                    ></div>
                  </div>

                  <!-- 工具来源二级拆解：普通工具（逐项，限高滚动）/ MCP / Skill（分组合计） -->
                  <div
                    v-if="row.type === 'TOOL' && toolRowExpanded && (toolGroupRows.length || ordinaryToolRows.length)"
                    data-testid="token-audit-tool-sources"
                    class="mt-1.5 rounded-lx-md border border-lx-border-subtle bg-lx-surface-sunken p-2"
                  >
                    <div class="flex items-center justify-between border-b border-lx-border-subtle pb-1 text-lx-fs-2xs text-lx-faint">
                      <span>{{ t('chat.tokenAudit.byToolSource') }}</span>
                      <span>{{ t('chat.tokenAudit.toolTotal') }}</span>
                    </div>
                    <!-- 逐项工具明细：工具个数没有上界（实测一个会话几十个），必须限高独立滚动，
                         否则整块把面板顶穿、把下面的 MCP / Skill 合计挤出视野。 -->
                    <div
                      v-if="ordinaryToolRows.length"
                      data-testid="token-audit-tool-items"
                      class="mt-1.5 max-h-32 space-y-1 overflow-y-auto pr-1"
                    >
                      <div v-for="item in ordinaryToolRows" :key="item.toolName" data-testid="token-audit-tool-item" class="space-y-1">
                        <div class="flex items-center justify-between gap-2 font-mono text-lx-fs-xs text-lx-secondary">
                          <span class="truncate" :title="item.toolName">{{ item.toolName }}</span>
                          <span class="shrink-0">{{ formatTokenAmount(item.tokens) }}</span>
                        </div>
                        <!-- 色条只比较参数和输出正文，框架总量还包含消息封装。 -->
                        <div
                          v-if="item.argumentTokens !== null && item.outputTokens !== null && (item.argumentTokens > 0 || item.outputTokens > 0)"
                          data-testid="token-audit-tool-io-bar"
                          class="flex h-1 overflow-hidden rounded-lx-full"
                          aria-hidden="true"
                        >
                          <div class="basis-0 bg-lx-accent" :style="{flexGrow: item.argumentTokens}"></div>
                          <div class="basis-0 bg-lx-success" :style="{flexGrow: item.outputTokens}"></div>
                        </div>
                        <div v-if="item.argumentTokens !== null || item.outputTokens !== null" class="flex flex-wrap gap-x-3 text-lx-fs-2xs text-lx-muted">
                          <span v-if="item.argumentTokens !== null" class="inline-flex items-center gap-1">
                            <span aria-hidden="true" class="size-1.5 rounded-lx-full bg-lx-accent"></span>
                            {{ t('chat.tokenAudit.toolArguments') }} <span class="font-mono">{{ formatTokenAmount(item.argumentTokens) }}</span>
                          </span>
                          <span v-if="item.outputTokens !== null" class="inline-flex items-center gap-1">
                            <span aria-hidden="true" class="size-1.5 rounded-lx-full bg-lx-success"></span>
                            {{ t('chat.tokenAudit.toolOutput') }} <span class="font-mono">{{ formatTokenAmount(item.outputTokens) }}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                    <!-- 分组合计（MCP / Skill）：与上面逐项明细之间留间距 + 分隔线 ——
                         它们是「同一个 TOOL 分项下的另外两类来源」，不是逐项明细的续行；
                         贴在一起会被读成「最后几个工具」。 -->
                    <div
                      v-if="toolGroupRows.length"
                      data-testid="token-audit-tool-groups"
                      class="mt-2 space-y-1 border-t border-lx-border-subtle pt-2"
                    >
                      <div v-for="group in toolGroupRows" :key="group.kind" class="flex items-center justify-between gap-2">
                        <span class="text-lx-fs-sm font-medium text-lx-primary">{{ t(group.labelKey) }}</span>
                        <span class="flex shrink-0 items-center gap-1.5 font-mono">
                          <span class="text-lx-fs-sm font-medium text-lx-primary">{{ formatTokenAmount(group.tokens) }}</span>
                          <span v-if="ratioText(group.ratio)" class="w-9 text-right text-lx-fs-2xs text-lx-faint">{{ ratioText(group.ratio) }}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 3. 其他消息（请求开销）：独立分隔线，可展开工具定义构成 -->
            <section
              v-if="showBreakdown && showOverhead"
              data-testid="token-audit-overhead"
              class="space-y-1.5 border-t border-lx-border-subtle pt-2.5"
            >
              <button
                type="button"
                :aria-expanded="overheadExpanded"
                class="flex w-full items-center justify-between gap-2 text-left"
                @click="toggleOverhead"
              >
                <span class="flex min-w-0 items-center gap-1">
                  <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-lx-full bg-lx-warning"></span>
                  <span class="shrink-0 text-lx-fs-sm font-medium text-lx-primary">{{ t('chat.tokenAudit.otherMessages') }}</span>
                  <span
                    v-if="overheadItemCount !== null"
                    class="shrink-0 rounded border border-lx-border-subtle bg-lx-surface-active px-1 text-lx-fs-2xs text-lx-muted"
                  >{{ t('chat.tokenAudit.itemCount', {count: overheadItemCount}) }}</span>
                  <svg
                    v-if="definitionRows.length > 0"
                    class="h-2.5 w-2.5 shrink-0 text-lx-faint transition-transform"
                    :class="overheadExpanded ? 'rotate-180' : ''"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
                <!-- 父项金额：不显示它，消息构成永远合不上（用户只能看到两个子项裸奔） -->
                <span
                  v-if="overheadSummary.tokens !== null"
                  data-testid="token-audit-overhead-total"
                  class="flex shrink-0 items-center gap-2 font-mono"
                >
                  <span class="text-lx-fs-sm font-medium text-lx-primary">
                    {{ formatTokenAmount(overheadSummary.tokens) }}<span class="text-lx-fs-2xs text-lx-faint"> {{ t('chat.tokenAudit.tokenUnit') }}</span>
                  </span>
                  <span v-if="overheadSummary.ratioPercent" class="w-9 text-right text-lx-fs-xs text-lx-faint">
                    {{ overheadSummary.ratioPercent }}
                  </span>
                </span>
              </button>

              <div
                v-if="definitionRows.length > 0 && overheadExpanded"
                data-testid="token-audit-definitions"
                class="space-y-1 rounded-lx-md border border-lx-border-subtle bg-lx-surface-sunken p-2"
              >
                <div class="flex items-center justify-between border-b border-lx-border-subtle pb-1 text-lx-fs-2xs text-lx-faint">
                  <span>{{ t('chat.tokenAudit.toolDefinitionComposition') }}</span>
                  <span>{{ t('chat.tokenAudit.ratio') }}</span>
                </div>
                <div v-for="row in definitionRows" :key="row.key" class="flex items-center justify-between gap-2">
                  <span class="flex min-w-0 items-center gap-1">
                    <span class="truncate text-lx-fs-xs text-lx-secondary">{{ t(row.labelKey) }}</span>
                    <!-- 「其它」是框架分词口径差：内部术语说不清，挂个感叹号，hover 时讲人话 -->
                    <span
                      v-if="row.key === 'framing'"
                      data-testid="token-audit-framing-hint"
                      class="inline-flex shrink-0 cursor-help text-lx-faint"
                      :title="t('chat.tokenAudit.definition.framingHint')"
                      :aria-label="t('chat.tokenAudit.definition.framingHint')"
                    >
                      <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke-width="2" />
                        <path stroke-linecap="round" stroke-width="2" d="M12 8v4.5" />
                        <path stroke-linecap="round" stroke-width="2" d="M12 16h.01" />
                      </svg>
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5 font-mono text-lx-fs-xs">
                    <span class="text-lx-secondary">{{ formatTokenAmount(row.tokens) }}</span>
                    <span v-if="ratioText(row.ratio)" class="w-9 text-right text-lx-faint">{{ ratioText(row.ratio) }}</span>
                  </span>
                </div>
              </div>
            </section>
          </template>
        </template>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
/* 滑入/滑出：与设计稿一致的「右侧推入 + 淡入」，收起后完全不可点 */
.token-audit-slide-enter-active,
.token-audit-slide-leave-active {
  transition: transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 250ms ease;
}

.token-audit-slide-leave-active {
  pointer-events: none;
}

.token-audit-slide-enter-from,
.token-audit-slide-leave-to {
  transform: translateX(110%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .token-audit-slide-enter-active,
  .token-audit-slide-leave-active {
    transition: none;
  }
}
</style>

