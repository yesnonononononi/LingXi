
<template>
  <div :class="['w-full py-3 px-2 sm:px-4 transition-colors', props.message.role === 'user' && !isDelegatedTask ? 'flex justify-end' : 'flex justify-start']">
    <DelegatedTaskMessage
      v-if="isDelegatedTask"
      :content="props.message.content"
      :recipientName="props.taskRecipientName"
      :isDark="isDark"
    />
    
    <!-- 1. 用户消息展示样式 (匹配左图：无头像，柔和浅蓝背景圆角气泡，下方展示时间与复制图标) -->
    <div v-else-if="props.message.role === 'user'" class="flex min-w-0 max-w-full flex-col items-end sm:max-w-2xl group" data-testid="user-message">
      <!-- 气泡内容 -->
      <div class="relative flex min-w-0 max-w-full items-center gap-2">
        <!-- 报错标识已移除：失败是轮次的属性，由回答组统一渲染（turn.status=FAILED + errorReason） -->
        <div
          data-testid="user-message-bubble"
          :class="[
            'min-w-0 max-w-full rounded-[18px] text-sm leading-relaxed whitespace-pre-wrap transition-colors [overflow-wrap:anywhere] overflow-hidden',
            userImageUrls.length ? 'p-2' : 'px-4 py-2.5',
            isDark ? 'bg-zinc-800 text-zinc-100 border border-white/[0.08] shadow-xs' : 'bg-[#edf3fc] text-gray-800'
          ]"
        >
          <div v-if="userImageUrls.length" class="mb-2 max-w-sm flex flex-wrap gap-2" data-testid="user-images">
            <img
              v-for="(imageUrl, index) in userImageUrls"
              :key="index"
              :src="imageUrl"
              :alt="t('chat.message.userUploadIndex', { index: index + 1 })"
              :class="userImageUrls.length > 1 ? 'h-28 w-28' : 'max-h-64 w-auto'"
              class="object-contain rounded-xl border border-black/10 dark:border-white/10 cursor-pointer hover:opacity-95 transition"
              @click="handleImageClick(imageUrl)"
            />
          </div>
          <div :class="userImageUrls.length ? 'px-2 pb-1' : ''" data-testid="user-message-text">
            {{ props.message.content }}
          </div>
        </div>
      </div>

      <!-- 气泡下方时间与复制图标 (完全匹配左图)；受理被拒的气泡额外标「未发送」并给重发入口 -->
      <div class="flex items-center gap-2 mt-1.5 text-xs text-lx-faint pr-1 select-none">
        <span>{{ displayTime }}</span>
        <!-- 受理被拒：这条消息后端不存在（未进 transcript / 未进模型上下文），绝不呈现成已发送 -->
        <template v-if="props.message.unsent">
          <span class="text-amber-500 dark:text-amber-400 font-medium" data-testid="unsent-badge">
            {{ t('chat.message.unsent') }}
          </span>
          <button
            type="button"
            @click="emit('resendUnsent', props.message.id)"
            class="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition p-0.5"
            :title="t('chat.message.resendTip')"
          >
            {{ t('chat.message.resend') }}
          </button>
        </template>
        <button
          data-testid="user-message-copy"
          @click="copyContent"
          class="hover:text-gray-600 dark:hover:text-zinc-200 transition p-0.5"
          :title="copied ? t('common.copied') : t('chat.message.copyContent')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <button v-if="!props.message.unsent && props.message.turnId"
          type="button" data-testid="edit-resend" :disabled="!props.canResend || !props.message.serverMessageId"
          :aria-label="t('chat.controls.editResend')" :title="resendTitle" @click="emit('editResend', props.message)"
          class="hover:text-gray-600 dark:hover:text-zinc-200 transition p-0.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m16 4 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 2. Agent 回复展示样式 (匹配右图：无头像，顶部折叠"已思考 >"及分割线，正文高亮，底部丰富状态操作栏) -->
    <div v-else class="flex flex-col items-start w-full max-w-lx-chat space-y-2.5">
      
      <div v-if="processParts.length || props.message.isExploring" class="w-full min-w-0" data-testid="whole-process">
        <button type="button" data-testid="whole-process-toggle" :aria-expanded="wholeProcessExpanded"
          class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs cursor-pointer"
          :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-gray-700'"
          @click="processExpansion = !wholeProcessExpanded">
          <svg class="h-3.5 w-3.5 shrink-0 transition-transform" :class="wholeProcessExpanded ? 'rotate-90' : ''"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
          </svg>
          <span class="font-medium">{{ t('chat.message.process') }}</span>
          <span v-if="!wholeProcessExpanded && wholeProcessStatus" class="min-w-0 truncate text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="whole-process-status">{{ wholeProcessStatus }}</span>
        </button>
        <CollapseTransition>
          <div v-show="wholeProcessExpanded" class="mt-1 space-y-2.5" data-testid="whole-process-content">
            <template v-for="part in processParts" :key="part.id">
              <div v-if="part.kind === 'text'" class="w-full select-text" data-testid="process-text">
                <MarkdownRenderer v-if="wholeProcessExpanded" :content="part.message.text" :is-dark="isDark" :process-text="true" />
              </div>
              <ChatProcessSegment v-else :visible="wholeProcessExpanded" :segment="part" :message="props.message" :turn="props.turn"
                :active="!part.closed && processIsStreaming"
                :sub-sessions="props.subSessions" :session-id="props.sessionId" :is-dark="isDark"
                @select-sub-session="emit('selectSubSession', $event)" />
            </template>
            <div v-if="!processParts.length && props.message.isExploring" class="text-xs text-lx-muted" role="status">
              {{ t('chat.message.thinking') }}
            </div>

          </div>
        </CollapseTransition>
      </div>

      <!-- 统一互动卡片：PLAN / CHOICE / COMMAND 三类 PROMISE 卡片（含 UNAVAILABLE）。
           渲染在过程折叠区之外，作为一等时间线项，确保用户可操作项不会被吞进折叠框。 -->
      <template v-for="entry in groupedCardItems" :key="entry.id">
        <CommandApprovalGroup
          v-if="entry.commands"
          :entries="entry.commands"
          :session-id="props.sessionId"
          :is-dark="isDark"
        />
        <ChoiceQuestionGroup
          v-else-if="entry.choices"
          :entries="entry.choices"
          :response-id="entry.responseId!"
          :expected-count="props.message.toolCalls?.filter(call => call.responseId === entry.responseId && call.toolName === AgentToolName.RequireChoice).length ?? 0"
          :is-dark="isDark"
        />
        <!-- 待决策卡片整卡展开（要按键）；已决卡片默认收成一行，细节按需展开 -->
        <div v-else-if="!entry.card.pending" class="w-full">
          <button
            type="button"
            @click="toggleCard(entry.id)"
            class="w-full flex items-center gap-1.5 text-xs py-1 transition select-none text-left cursor-pointer min-w-0"
            :class="isDark ? 'text-zinc-300 hover:text-zinc-100' : 'text-gray-600 hover:text-gray-900'"
          >
            <svg
              :class="['w-3 h-3 transition-transform duration-200 shrink-0', isCardExpanded(entry.id) ? 'rotate-90' : '']"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <!-- 已决卡片摘要：状态点 + 类型图标，与过程区灰字拉开层级 -->
            <span :class="['w-1.5 h-1.5 rounded-full shrink-0', cardDotClass(resolveCardTone(entry.card))]"></span>
            <svg
              class="w-3.5 h-3.5 shrink-0 text-lx-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" :d="cardKindIconPath(entry.card.kind)" />
            </svg>
            <span class="truncate">{{ cardSummary(entry.card) }}</span>
          </button>
          <CollapseTransition>
            <div v-if="isCardExpanded(entry.id)">
              <PromptCard
                :prompt-card="entry.card"
                :session-id="props.sessionId"
                :is-dark="isDark"
              />
            </div>
          </CollapseTransition>
        </div>
        <PromptCard
          v-else
          :prompt-card="entry.card"
          :session-id="props.sessionId"
          :is-dark="isDark"
        />
      </template>

      <!-- 上下文压缩提示：与「模型重试」是两件不同的事，各自有唯一实现 -->
      <transition name="context-compact-fade">
        <div
          v-if="props.message.isCompressingContext"
          role="status"
          class="w-full my-3 py-1 flex items-center gap-3 select-none context-compact-bar"
          :title="compactingTitle"
        >
          <!-- 两侧等分剩余空间，保证提示始终居中。 -->
          <div class="flex-1 min-w-0 h-[1px] bg-zinc-200 dark:bg-gray-700/60"></div>

          <div class="flex items-center gap-1.5 text-xs text-lx-muted font-normal shrink-0">
            <svg class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <span class="context-compact-shimmer-text">{{ t('chat.message.compressing') }}</span>
          </div>

          <div class="flex-1 min-w-0 h-[1px] bg-zinc-200 dark:bg-gray-700/60"></div>

        </div>
      </transition>

      <!-- 模型调用失败、等待重试：实现在 ModelRetryNotice，子会话详情复用同一个组件 -->
      <ModelRetryNotice v-if="props.message.modelRetry" :retry="props.message.modelRetry" />

      <!-- 回复正文 (使用 Markdown 渲染，包含代码高亮、代码块复制、表格与列表) -->
      <div
        v-if="bodyVisible"
        class="w-full text-sm font-normal my-1"
      >
        <slot name="body" v-bind="bodySlotProps">
          <!-- 兜底实现与宿主注册项指向同一份组件（MessageBodyDefault），不存在两份渲染代码漂移。 -->
          <component :is="injectedBody" v-if="injectedBody" v-bind="bodySlotProps" />
          <MessageBodyDefault v-else v-bind="bodySlotProps" />
        </slot>
      </div>

      <!-- 底部工具与状态栏 (对应右图：复制、赞、踩、重试、用量、耗时、时间) - 仅在会话生成结束时展示 -->
      <!-- 出现时机契约：活跃期只跟随后端终结/开始事件（isMessageCompleted）；非活跃期按 turnId 回答组 -->
      <!-- 收敛为组尾一次（isGroupTail !== false），避免同一轮次「本地气泡 + 对账行」并存时双工具条 -->
      <div v-if="isMessageCompleted && isGroupTail !== false" class="flex flex-wrap items-center gap-4 pt-1 text-xs text-zinc-400 select-none">
        <slot name="actions" v-bind="actionsSlotProps">
          <component :is="injectedActions" v-if="injectedActions" v-bind="actionsSlotProps" />
          <MessageActionsBar v-else v-bind="actionsSlotProps" />
        </slot>
      </div>
    </div>


  </div>
</template>
<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import { CHAT_MESSAGE_SLOTS_KEY } from '../../types/chatMessageSlots';
import type { ChatMessageBodySlotProps, ChatMessageActionsSlotProps } from '../../types/chatMessageSlots';
import type { ChatMessage, ToolCallTrace, SubSessionVO, ProcessTimelineItem, ChatTurn, PromptCardData } from '../../types/chat';
import { toPromptCardData, buildCardSummary } from '../../utils/toolCallCard';
import { cardDotClass, cardKindIconPath, resolveCardTone } from '../../utils/cardUi';
import { AgentToolName } from '../../utils/toolNames';
import { buildProcessTimeline } from '../../utils/processTimeline';
import { buildProcessSegments, summarizeProcess } from '../../utils/processSegments';
import { formatProcessStatus } from '../../utils/processHeadline';
import { isActiveTurnStatus, isFailedTurnStatus, turnStatusLabel } from '../../utils/turnStatus';
import { formatDurationOrPlaceholder } from '../../utils/format';
import { resolveTokenUsage } from '../../utils/tokenUsage';
import MessageActionsBar from './MessageActionsBar.vue';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import MarkdownRenderer from './MarkdownRenderer.vue';
import MessageBodyDefault from './MessageBodyDefault.vue';
import ModelRetryNotice from './ModelRetryNotice.vue';
import DelegatedTaskMessage from './DelegatedTaskMessage.vue';
import PromptCard from './PromptCard.vue';
import CommandApprovalGroup from './CommandApprovalGroup.vue';
import { groupCommandApprovals, groupChoiceQuestions, type PromptCardEntry } from '../../utils/promptCardGroups';
import ChoiceQuestionGroup from './ChoiceQuestionGroup.vue';
import CollapseTransition from '../common/CollapseTransition.vue';
import ChatProcessSegment from './ChatProcessSegment.vue';

const props = defineProps<{
  message: ChatMessage;
  taskRecipientName?: string;
  subSessions?: SubSessionVO[];
  isDark?: boolean;
  /** 消息所属会话 id：互动卡片的决策接口据此定位 */
  sessionId?: string | number;
  /**
   * 本条消息所属回答组的轮次信息（按 turnId 从会话轮次表解析）。
   * null = 无轮次（旧数据 / 未采集），**绝不**回落成会话累计用量或 0。
   */
  turn?: ChatTurn | null;
  /**
   * 是否为所在回答组的末条：仅组尾展示一次执行元信息（模型/提供方/token/状态/总历时），
   * 避免「同一执行跨页」时两个部分组各挂一次。
   */
  isGroupTail?: boolean;
  isLastAssistant?: boolean;
  isSending?: boolean;
  canResend?: boolean;
}>();

const { isDark: globalIsDark } = useTheme();
const userImageUrls = computed(() => props.message.imageUrls ?? (props.message.imageUrl ? [props.message.imageUrl] : []));
const resendTitle = computed(() => !props.message.serverMessageId ? t('chat.controls.messageSyncPending')
  : !props.canResend ? t('chat.controls.waitUntilIdle') : t('chat.controls.editResend'));
const isDark = computed(() => props.isDark ?? globalIsDark.value);
/**
 * 上下文压缩提示的 title：权威用量缺失时退回提示文案本身。
 *
 * <p>重试提示**不在这里**：它有自己的组件与文案实现（{@code ModelRetryNotice} +
 * {@code views/chat/modelRetryStatus.ts}），两件事共用一个字段时，谁覆盖谁全靠
 * 三元表达式里的先后顺序，改一个必然踩另一个。</p>
 */
const compactingTitle = computed(() => props.message.contextUsage?.tokenCount
  ? t('chat.message.contextTitle', {
    used: props.message.contextUsage.tokenCount,
    max: props.message.contextUsage.maxTokens || 0
  })
  : t('chat.message.compressing'));
// 委派身份由后端父轮次声明，不能从任务文本或会话位置猜测。
const isDelegatedTask = computed(() => props.message.role === 'user' && !!props.turn?.parentTurnId);

/**
 * 宿主注册的插槽渲染器（三级解析的中间层：父级 `$slots` > 宿主注入 > 内置默认）。
 *
 * <p>必须**按字段判空**，不能按对象真值判：宿主 `provide(CHAT_MESSAGE_SLOTS_KEY, {})` 时对象为真
 * 但两个字段缺省，按对象真值判会把两侧都当成「已注册」，结果渲染出空白。
 * `inject` 的默认值给 `undefined`，与「未注册」语义一致。</p>
 */
const slotOverrides = inject(CHAT_MESSAGE_SLOTS_KEY, undefined);
const injectedBody = computed(() => slotOverrides?.body);
const injectedActions = computed(() => slotOverrides?.actions);

defineSlots<{
  /** 正文内容。外层容器/class/时机由组件拥有，本插槽只替换容器内部。 */
  body(props: ChatMessageBodySlotProps): unknown;
  /** 底部工具条内容。同上，容器与出现时机由组件拥有。 */
  actions(props: ChatMessageActionsSlotProps): unknown;
}>();



const emit = defineEmits<{
  (e: 'selectSubSession', id: string | number): void;
  /** 重发一条「未发送」的提问（受理被拒留下的本地气泡）。 */
  (e: 'resendUnsent', messageId: string): void;
  (e: 'editResend', message: ChatMessage): void;
}>();

/**
 * 是否还有工具停在「未收尾」态（调用中 / 待定）。
 *
 * <p>「未收尾」= 工具已经发起但还没拿到终态。只看这两种状态，不看成功/失败：
 * 历史行里工具恒为 success/failed，不会命中，因此不会把已完成的历史轮次误判成运行中。</p>
 */
function hasPendingTool(toolCalls?: ToolCallTrace[]): boolean {
  if (!toolCalls || toolCalls.length === 0) return false;
  return toolCalls.some(call => call != null && (call.status === 'calling' || call.status === 'pending'));
}

// 复制反馈（消息正文按布尔键控；见 composables/useCopyFeedback.ts）
const { isCopied: copied, copy: copyContentRaw } = useCopyFeedback();

const processTimeline = computed(() => buildProcessTimeline(props.message));
const processParts = computed(() => buildProcessSegments(processTimeline.value, props.subSessions, props.sessionId));

// 自动展开只跟随执行阶段；用户一旦操作，就保留用户选择。
const processExpansion = ref<boolean | null>(null);
const wholeProcessExpanded = computed(() => processExpansion.value ?? processIsStreaming.value);
const wholeProcessSummary = computed(() => summarizeProcess(processParts.value.flatMap(part =>
  part.kind === 'process' ? part.items : []), props.subSessions));
const wholeProcessStatus = computed(() => formatProcessStatus(wholeProcessSummary.value, { running: 'never' }));


/** 过程折叠区之外的互动卡片（映射为卡片展示数据）。 */
const cardItems = computed<PromptCardEntry[]>(() =>
  processTimeline.value
    .filter(item => item.type === 'prompt_card' && !!item.card)
    .map(item => ({ id: item.id, responseId: item.responseId ?? undefined, card: toPromptCardData(item.card as NonNullable<ProcessTimelineItem['card']>) }))
);
const groupedCardItems = computed(() => groupChoiceQuestions(groupCommandApprovals(cardItems.value)));

/** 已决卡片默认收成一行（避免大卡片常驻页底占位），细节按需展开；待决策卡片整卡展开。 */
const expandedCardIds = ref<Record<string, boolean>>({});
const toggleCard = (id: string) => {
  expandedCardIds.value[id] = !expandedCardIds.value[id];
};
const isCardExpanded = (id: string): boolean => !!expandedCardIds.value[id];
const cardSummary = (card: PromptCardData): string => buildCardSummary(card);

/**
 * 轮次是否**仍在运行**（权威判据，供「过程框展开态」与「工具条出现时机」共用）。
 *
 * <p>多轮工具调用期间会出现一个「守卫真空」：`handleToolCall` 清掉了
 * `isThinking` / `isExploring`（工具调用意味着本轮叙述告一段落），而后台 reconcile
 * 重建的行 `isComplete` 恒为 true，若此时 `turn.status` 尚未解析出来，所有既有守卫
 * 全部放行 —— 界面就会在轮次跑到一半时把过程框收起，且不再自动展开。</p>
 *
 * <p>这里补一条只看「事实」的判据：<b>只要有工具停在调用中 / 待定，轮次就没结束</b>。
 * 它不依赖 `isThinking` / `turn` 是否及时到位，因此不存在同样的真空。</p>
 */
const isTurnRunning = computed(() => {
  if (props.message.isThinking || props.message.isExploring) return true;
  if (props.message.isComplete === false) return true;
  if (props.isSending && props.isLastAssistant) return true;
  const status = String(props.turn?.status ?? '').toUpperCase();
  if (isActiveTurnStatus(status)) return true;
  return hasPendingTool(props.message.toolCalls);
});

/** 历史待确认工具不代表正在输出；有轮次摘要时由执行状态决定实时预览。 */
const processIsStreaming = computed(() => !props.message.isSuspended && (props.turn
  ? props.turn.status === 'RUNNING'
  : props.message.isComplete !== true && isTurnRunning.value));

/** 终态底栏不依赖正文，只有思考内容也必须展示；须在完成判据首次求值前声明。 */
const isTerminalTurn = computed(() => props.message.cancelled === true || props.message.failed === true);

/** 该助手回答是否已完成会话生成（会话/响应结束时才展示底栏工具栏与状态） */
const isMessageCompleted = computed(() => {
  // 1~4. 权威「仍在运行」判据集中收敛在 isTurnRunning（含思考中 / 显式未完成 /
  //      全局发送中且为最新回答 / 轮次摘要活跃 / 仍有工具未收尾）。
  if (isTurnRunning.value) {
    return false;
  }
  // 5. 轮次摘要若存在且仍在活跃态，且没有本端收到的终结证据，则不算完成。
  //
  // ⚠️ 只在 **status 明确存在** 时用摘要拦截：status 为空（历史行没有轮次摘要）时不能拦 ——
  // 那会把「旧数据 / 老会话」整片挡掉（工具条与收起行为全失效）。历史行的完成性由
  // isTurnRunning 里「已无未收尾工具」放行，不需要在这里再判一次。
  const status = String(props.turn?.status ?? '').toUpperCase();
  const hasTerminalEvidence = props.message.durationMs != null
    || props.message.tokenInfo != null
    || props.message.tokens != null;
  if (status !== '' && isActiveTurnStatus(status) && !hasTerminalEvidence) {
    return false;
  }
  // 终态标记不依赖正文或轮次摘要是否已到，运行中的守卫仍须先判断。
  if (isTerminalTurn.value) {
    return true;
  }
  // 7. 其余必须真有内容或工具，否则底栏没有可挂的语义
  return !!(props.message.content || props.message.toolCalls?.length);
});

/** 本条消息所属回答组的轮次信息（权威来源）；null = 无轮次，不伪造统计。 */
const execSummary = computed(() => props.turn ?? null);

/**
 * 是否展示本组的执行元信息（用量/耗时）。
 * 仅组尾展示一次；实时流在摘要尚未写入会话表时，用气泡自带统计即时展示。
 * 旧数据（无摘要且无自带统计）一律隐藏，不显示成 0。
 */
const showExecutionMeta = computed(() => {
  if (props.isGroupTail === false) return false;
  if (execSummary.value) return true;
  return props.message.tokenInfo != null || props.message.tokens != null || (props.message.durationMs ?? 0) > 0;
});

const displayDuration = computed(() => {
  const e = execSummary.value;
  if (e) {
    // elapsedMs 为 null（startedAt 缺失）→ 暂无统计，绝不当 0
    return formatDurationOrPlaceholder(e.elapsedMs);
  }
  // 实时流：本组摘要尚未写入会话表时，用气泡自带耗时兜底；都缺失则「暂无统计」
  return formatDurationOrPlaceholder(props.message.durationMs);
});

const tokenUsage = computed(() => resolveTokenUsage(execSummary.value, props.message));
/** 执行状态展示（仅摘要存在时展示）；进行中/失败/终态用不同配色，失败附带原因全文。 */
const execStatusMeta = computed(() => {
  const e = execSummary.value;
  if (!e) return null;
  const running = isActiveTurnStatus(e.status);
  const failed = isFailedTurnStatus(e.status);
  return {
    text: turnStatusLabel(e.status),
    running,
    failed,
    errorReason: failed ? (e.errorReason || '').trim() : ''
  };
});

const displayTime = computed(() => {
  // 「开始时间」取轮次摘要的 startedAt：历史投影给气泡的 timestamp 是 Date.now() 兜底，
  // 不是真实发送时间；有摘要就一律用权威值，用户气泡与底栏因此显示同一个时刻。
  const startedAt = props.turn?.startedAt;
  const value = startedAt ? new Date(startedAt) : new Date(props.message.timestamp);
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
});


const copyContent = () => {
  void copyContentRaw(props.message.content);
};

/**
 * 正文「思考中且未在探索」判定。
 *
 * <p>抽成 computed 的唯一理由是它**被两处引用**（外层 v-if 与默认渲染器的 is-thinking），
 * 原来两处各写一遍同样的表达式；表达式逐字照抄，只换载体，不改语义。</p>
 */
const bodyIsThinking = computed(() => !!props.message.isThinking && !props.message.isExploring);

/** 正文是否出现：把原 v-if 的行内条件收敛成单一事实来源（语义等价，纯搬家）。 */
const bodyVisible = computed(() => !!props.message.content || (bodyIsThinking.value && processParts.value.length === 0));

/**
 * 正文插槽 props：只暴露渲染正文必需的 3 项。
 * 用 computed 包一层而不是普通对象：`message` 是 props，消息流式更新时必须跟着变。
 */
const bodySlotProps = computed<ChatMessageBodySlotProps>(() => ({
  message: props.message,
  isDark: isDark.value,
  isThinking: bodyIsThinking.value
}));

/**
 * 操作区插槽 props：11 项全部来自组件内既有派生值，消费者不需要（也不允许）重算。
 *
 * <p>`turn` 用 `props.turn ?? null` 归一：外层可能传 `undefined`，而契约里 null 表示「无轮次」，
 * 两者混用会让消费者写出两种判空分支。</p>
 */
const actionsSlotProps = computed<ChatMessageActionsSlotProps>(() => ({
  message: props.message,
  isDark: isDark.value,
  isMessageCompleted: isMessageCompleted.value,
  execStatusMeta: execStatusMeta.value,
  showExecutionMeta: showExecutionMeta.value,
  tokenUsage: tokenUsage.value,
  turn: props.turn ?? null,
  displayDuration: displayDuration.value,
  displayTime: displayTime.value,
  copied: copied.value,
  copyContent,
  // 与 copyContent 共用同一个 useCopyFeedback 实例：反馈状态同源，替换实现不会出现「复制了但提示不亮」。
  copyText: copyContentRaw
}));


const handleImageClick = (url?: string) => {
  if (url) {
    window.open(url, '_blank');
  }
};
</script>

<style scoped>
/* 淡入淡出过渡 */
.context-compact-fade-enter-active,
.context-compact-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.context-compact-fade-enter-from,
.context-compact-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 高亮在循环两端都位于文字外，复位时不会闪回或滞留在右侧。 */
.context-compact-shimmer-text {
  background: linear-gradient(
    90deg,
    var(--lx-text-muted) 40%,
    var(--lx-text-primary) 50%,
    var(--lx-text-muted) 60%
  );
  background-size: 300% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: context-shimmer-text 2.2s linear infinite;
}

@keyframes context-shimmer-text {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0% 0;
  }
}

</style>
