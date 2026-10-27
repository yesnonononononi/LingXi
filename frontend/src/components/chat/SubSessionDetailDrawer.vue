<script setup lang="ts">
import SessionConnectionNotice from './SessionConnectionNotice.vue';
import type { StreamHealthState } from '../../views/chat/sessionEventStream';
import { ref, watch, computed } from 'vue';
import type { SubSessionVO, ChatMessage, ToolCallTrace } from '../../types/chat';
import { chatApi } from '../../services/chat';
import { formatClockTime } from '../../utils/format';
import { absorbSubSessionHistory } from '../../views/chat/subSessionHistory';
import { parseToolDiff } from '../../utils/toolDiff';
import { shouldShowToolArguments, unwrapToolResultEnvelope } from '../../utils/toolMeta';
import { resolveToolRenderName } from '../../utils/toolDisplayNames';
import { toSubItemStatus } from '../../utils/subSessionStatus';
import { subItemStatusDotClass, subItemStatusLabel } from '../../utils/asyncDelegation';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ModelRetryNotice from './ModelRetryNotice.vue';
import GradientText from '../common/GradientText.vue';
import { useTheme } from '../../composables/useTheme';
import { useChatScroll } from '../../views/chat/useChatScroll';
import { useI18n } from '../../i18n';

const props = defineProps<{
  isOpen: boolean;
  subSession: SubSessionVO | null;
  isDark?: boolean;
  streamHealthState?: StreamHealthState;
}>();

const { t } = useI18n();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const emit = defineEmits<{
  (e: 'reconnect'): void;
  (e: 'close'): void;
}>();

const isLoading = ref(false);
const messagesContainerRef = ref<HTMLElement | null>(null);
const scroll = useChatScroll({
  messagesContainerRef: computed(() => ({ getContainer: () => messagesContainerRef.value })),
});

watch([() => props.isOpen, () => props.subSession?.id, isLoading, messagesContainerRef],
  ([open, id, loading]) => {
    if (open && id != null && !loading) scroll.scrollToBottomForce();
  }, { flush: 'post', immediate: true });
/**
 * 展示数据直接取自会话 VO 上的**实时数组**（与右侧面板、实时 reducer 同一份）。
 *
 * <p>抽屉不再持有私有副本：副本既收不到实时事件（模型重试这类瞬时态在抽屉里彻底不可见），
 * 也会和右侧面板出现两套内容。历史分页只往里补齐，见 {@link absorbSubSessionHistory}。</p>
 */
const messages = computed<ChatMessage[]>(() => props.subSession?.messages ?? []);
/** 加载失败标记：区分「加载失败（可重试）」与「确实为空」 */
const loadError = ref(false);
// 复制反馈（布尔键控；见 composables/useCopyFeedback.ts）
const { isCopied: copied, copy: copyRaw } = useCopyFeedback();
const expandedThoughtMsgIds = ref<Record<string, boolean>>({});
const toggleThought = (msgId: string) => {
  expandedThoughtMsgIds.value[msgId] = !expandedThoughtMsgIds.value[msgId];
};

const expandedToolCallIds = ref<Record<string, boolean>>({});
const toggleToolCall = (tcId: string) => {
  expandedToolCallIds.value[tcId] = !expandedToolCallIds.value[tcId];
};

/**
 * 该工具是否有可展开的内容。
 *
 * <p>详情里只有「原始参数（仅命令/编辑工具）」与「执行结果」两块，都没有就不该给一个
 * 展开后空白的箭头。读文件是典型：它的结果是文件正文，后端已不下发，展开只会是空的。</p>
 */
const hasToolDetail = (tc: ToolCallTrace): boolean => {
  return (shouldShowToolArguments(tc.toolName) && !!tc.query) || !!tc.result;
};

let messagesRequestVersion = 0;
const loadMessages = async () => {
  const version = ++messagesRequestVersion;
  const sub = props.subSession;
  if (!sub || !sub.id) {
    isLoading.value = false;
    loadError.value = false;
    return;
  }

  isLoading.value = true;
  loadError.value = false;
  try {
    // 与主会话/右侧面板共用同一条历史管线：分页拉取后并入会话 VO 的实时数组，
    // 抽屉因此与实时事件读同一份数据（失败轮合成气泡也在同一处完成）。
    const res = await chatApi.fetchSessionMessages(sub.id, null, 100);
    if (version !== messagesRequestVersion) return;
    if (res.ok) {
      absorbSubSessionHistory(props.subSession, res.data);
    } else {
      // 加载失败：区别于「确实为空」，置失败态允许重试
      loadError.value = true;
    }
  } catch (err) {
    if (version !== messagesRequestVersion) return;
    console.error('加载子会话消息列表失败:', err);
    loadError.value = true;
  } finally {
    if (version === messagesRequestVersion) isLoading.value = false;
  }
};

watch(
  () => [props.isOpen, props.subSession?.id],
  ([open]) => {
    if (open) {
      void loadMessages();
    } else {
      messagesRequestVersion += 1;
      isLoading.value = false;
    }
  },
  { immediate: true }
);


const displayAgentName = computed(() => {
  return props.subSession?.agentName || (props.subSession?.agentId ? t('chat.subSession.agentIdFallback', { id: props.subSession.agentId }) : t('chat.subSession.agentFallback'));
});

/**
 * 状态栏展示态：权威来源是 {@code subSession.runStatus} + {@code lastOutcome}，
 * 复用 {@link toSubItemStatus}（唯一定义处），不硬编码、不二次猜测。
 * 子代理可能还在跑（协作式委派下工具早已 COMPLETED），因此绝不能写死「执行完成」。
 */
const subStatus = computed(() => toSubItemStatus(props.subSession?.runStatus, props.subSession?.lastOutcome));
const subStatusText = computed(() => subItemStatusLabel(subStatus.value));
const subStatusDot = computed(() => subItemStatusDotClass(subStatus.value));

const copyAllContent = () => {
  const text = messages.value
    .map(m => `${m.role === 'user' ? t('chat.subSession.delegatedTaskPrefix') : t('chat.subSession.subAgentReplyPrefix')}:\n${m.content}`)
    .join('\n\n');
  void copyRaw(text);
};

/**
 * 工具 diff 统计：统一走 utils/toolDiff.ts 的 parseToolDiff（收敛原因见该模块头注释）。
 * 仅把「未知(null)」适配成模板约定的 undefined 形态；原 `catch {}` 静默吞异常已由该模块统一告警。
 * 注意：此处**不传 description** —— 原实现只读结构化字段与 result，
 * 传入 description 会额外启用 `+N -M` 正则回退（rawArgs 可能命中），非严格等价。
 */
const getToolDiffStat = (tc: ToolCallTrace): { plusLines?: number; minusLines?: number } | null => {
  const stat = parseToolDiff({
    toolName: tc.toolName,
    category: tc.category,
    plusLines: tc.plusLines,
    minusLines: tc.minusLines,
    result: tc.result,
    context: `toolCall ${tc.id}`
  });
  if (!stat) return null;
  return {
    plusLines: stat.plusLines ?? undefined,
    minusLines: stat.minusLines ?? undefined
  };
};
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩背景 -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 bg-black/50 backdrop-blur-xs z-50 transition-opacity"
        @click="emit('close')"
      />
    </Transition>

    <!-- 右侧滑出抽屉面板 -->
    <Transition
      enter-active-class="transition duration-300 ease-out transform"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition duration-200 ease-in transform"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="isOpen"
        :class="[
          'fixed inset-y-0 right-0 w-full max-w-2xl shadow-2xl z-50 flex flex-col border-l transition-colors backdrop-blur-2xl',
          isDark ? 'bg-black/95 border-white/15 text-zinc-100 shadow-[0_0_60px_rgba(0,0,0,0.9)]' : 'bg-white border-zinc-200 text-gray-800'
        ]"
      >
        <!-- 抽屉头部 -->
        <div :class="['px-6 py-4 border-b flex items-center justify-between shrink-0', isDark ? 'border-white/10 bg-black/60' : 'border-zinc-100 bg-zinc-50/70']">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 via-indigo-600 to-cyan-400 flex items-center justify-center text-white shadow-sm shrink-0">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-semibold text-sm truncate dark:text-white dark:text-glow-white">{{ displayAgentName }}</h3>
                <span :class="['text-[11px] px-2 py-0.5 rounded-full font-mono font-medium', isDark ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' : 'bg-blue-50 text-blue-600 border border-blue-200']">
                  {{ t('chat.subSession.sessionLabel', { id: subSession?.id ?? '' }) }}
                </span>
              </div>
              <p class="text-xs text-zinc-400 dark:text-zinc-400 dark:text-glow-subtle truncate mt-0.5">
                {{ subSession?.name || subSession?.task || t('chat.subSession.fallbackName') }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <!-- 复制按钮 -->
            <button
              v-if="messages.length > 0"
              @click="copyAllContent"
              :class="['px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer', isDark ? 'border-white/15 hover:bg-white/5 text-zinc-300' : 'border-zinc-200 hover:bg-zinc-100 text-gray-600']"
              :title="copied ? t('chat.subSession.copyAllDone') : t('chat.subSession.copyAll')"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>{{ copied ? t('chat.subSession.copied') : t('chat.subSession.copyConversation') }}</span>
            </button>

            <!-- 关闭按钮 -->
            <button
              @click="emit('close')"
              :class="['p-1.5 rounded-lg text-zinc-400 hover:text-gray-600 dark:hover:text-zinc-200 hover:bg-white/5 transition cursor-pointer']"
              :title="t('chat.subSession.closeDetail')"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 会话状态与指标信息栏 -->
        <div :class="['px-6 py-2.5 border-b text-xs flex items-center justify-between gap-4 flex-wrap select-none', isDark ? 'border-white/10 bg-black/40 text-zinc-400' : 'border-zinc-100 bg-zinc-50/40 text-gray-500']">
          <div class="flex items-center gap-4">
            <span class="flex items-center gap-1.5">
              <span :class="['w-2 h-2 rounded-full', subStatusDot]"></span>
              <span>{{ subStatusText }}</span>
            </span>
          </div>
          <div v-if="subSession?.createTime" class="font-mono opacity-80 text-[11px]">
            {{ t('chat.subSession.createdAt', { time: new Date(subSession.createTime).toLocaleString() }) }}
          </div>
        </div>

        <SessionConnectionNotice :state="streamHealthState" @reconnect="emit('reconnect')" />

        <!-- 消息列表正文区域 -->
        <div ref="messagesContainerRef" data-testid="sub-session-detail-messages" class="flex-1 min-h-0 overflow-y-auto p-6 scrollbar-thin"
          @scroll="scroll.handleMessagesScroll" @wheel.passive="scroll.handleMessagesWheel"
          @touchstart.passive="scroll.handleTouchStart" @touchmove.passive="scroll.handleTouchMove">
          <div class="space-y-6">
          <div v-if="messages.length && (isLoading || loadError)" class="text-xs text-lx-muted" role="status">
            <span>{{ t(loadError ? 'chat.subSession.loadFailed' : 'chat.subSession.loadingTrajectory') }}</span>
            <button v-if="loadError" class="ml-2 underline" @click="loadMessages">{{ t('common.retry') }}</button>
          </div>
          <!-- 加载中骨架屏 -->
          <div v-if="isLoading && !messages.length" class="py-12 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-xs font-medium">{{ t('chat.subSession.loadingTrajectory') }}</span>
          </div>

          <!-- 加载失败状态（区别于「确实为空」，可重试） -->
          <div v-else-if="loadError && !messages.length" class="py-16 text-center text-zinc-400 text-xs flex flex-col items-center gap-3">
            <div class="w-12 h-12 rounded-full flex items-center justify-center bg-red-500/10 text-red-400">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
                        <span>{{ t('chat.subSession.loadFailed') }}</span>
            <button
              type="button"
              @click="loadMessages"
              :class="['px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer', isDark ? 'border-[#2c374d] hover:bg-[#1f2838] text-zinc-300' : 'border-zinc-200 hover:bg-zinc-100 text-gray-600']"
            >
              {{ t('common.retry') }}
            </button>
          </div>

          <!-- 空列表状态 -->
          <div v-else-if="messages.length === 0" class="py-16 text-center text-zinc-400 text-xs">
            <div class="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center bg-gray-500/10 text-zinc-400">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span>{{ t('chat.subSession.empty') }}</span>
          </div>

          <!-- 消息时序气泡 -->
          <template v-else>
            <div
              v-for="msg in messages"
              :key="msg.id"
              class="flex flex-col gap-2"
            >
              <!-- 角色标识与时间 -->
              <div class="flex items-center gap-2 text-xs text-zinc-400 select-none">
                <span :class="['font-medium px-2 py-0.5 rounded text-[11px]', msg.role === 'user' ? (isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-700') : (isDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-50 text-purple-700')]">
                  {{ msg.role === 'user' ? t('chat.subSession.managerInstruction') : displayAgentName }}
                </span>
                <span class="font-mono text-[11px]">{{ formatClockTime(msg.timestamp) }}</span>
              </div>

              <!-- 思考过程折叠 (CoT) -->
              <div v-if="msg.thoughtSteps?.length" class="space-y-1.5 my-1">
                <button
                  type="button"
                  @click="toggleThought(msg.id)"
                  class="text-xs font-medium flex items-center gap-1.5 cursor-pointer transition select-none"
                  :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'"
                >
                  <svg :class="['w-3 h-3 text-zinc-300 transition-transform duration-200', expandedThoughtMsgIds[msg.id] ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  <GradientText
                    v-if="!msg.isComplete && !msg.isSuspended && msg.thoughtSteps.some(step => step.status === 'running')"
                    :colors="['#40ffaa', '#4079ff', '#40ffaa', '#4079ff', '#40ffaa']"
                    :animation-speed="3"
                    :show-border="false"
                                        class="!p-0"
                  >{{ t('chat.subSession.deepThinking') }}</GradientText>
                  <span v-else>{{ t('chat.subSession.deepThinking') }}</span>
                </button>
                <div
                  v-if="expandedThoughtMsgIds[msg.id]"
                  :class="[
                    'my-2 ml-1 border-l-[3px] pl-4 pr-2 max-h-72 overflow-y-auto scrollbar-thin select-text space-y-3',
                    isDark ? 'border-zinc-700' : 'border-zinc-200'
                  ]"
                >
                  <MarkdownRenderer
                    v-for="step in msg.thoughtSteps"
                    :key="step.id"
                    :content="step.content"
                    :is-dark="isDark"
                    :thinking-text="true"
                  />
                </div>
              </div>

              <!-- 内部工具调用记录 (默认折叠) -->
              <div v-if="msg.toolCalls?.length" class="space-y-1.5 my-1">
                <div
                  v-for="tc in msg.toolCalls"
                  :key="tc.id"
                  :class="['rounded-xl border text-xs font-mono transition overflow-hidden', isDark ? 'border-white/15 bg-black/80' : 'border-zinc-200 bg-zinc-50']"
                >
                  <button
                    type="button"
                    :disabled="!hasToolDetail(tc)"
                    @click="toggleToolCall(tc.id)"
                    class="w-full p-2.5 flex items-center justify-between text-zinc-400 transition select-none text-left"
                    :class="hasToolDetail(tc) ? 'hover:text-zinc-200 cursor-pointer' : 'cursor-default'"
                  >
                    <div class="flex items-center gap-2 truncate min-w-0">
                      <!-- 与主过程框同一规则：无详情时留出箭头位，避免指示灯列左移 -->
                      <svg
                        v-if="hasToolDetail(tc)"
                        :class="['w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 shrink-0', expandedToolCallIds[tc.id] ? 'rotate-90' : '']"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <span v-else class="w-3.5 h-3.5 shrink-0" aria-hidden="true"></span>
                      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="tc.status === 'failed' ? 'bg-rose-500' : tc.status === 'calling' ? 'bg-amber-400 lx-live-dot' : 'bg-emerald-400'"></span>
                      <span class="font-semibold text-zinc-300 dark:text-zinc-100 truncate">{{ resolveToolRenderName(tc.toolName) }}</span>
                      <span
                        v-if="getToolDiffStat(tc)"
                        class="inline-flex items-center gap-1 font-mono text-[11px] font-medium leading-none shrink-0 select-none ml-1"
                      >
                        <span
                          v-if="getToolDiffStat(tc)!.plusLines !== undefined && (getToolDiffStat(tc)!.plusLines! > 0 || (getToolDiffStat(tc)!.plusLines === 0 && getToolDiffStat(tc)!.minusLines === 0))"
                          class="text-[#088f50] dark:text-emerald-400"
                        >+{{ getToolDiffStat(tc)!.plusLines }}</span>
                        <span
                          v-if="getToolDiffStat(tc)!.minusLines !== undefined && (getToolDiffStat(tc)!.minusLines! > 0 || (getToolDiffStat(tc)!.plusLines === 0 && getToolDiffStat(tc)!.minusLines === 0))"
                          class="text-[#b42c3f] dark:text-rose-400"
                        >-{{ getToolDiffStat(tc)!.minusLines }}</span>
                      </span>
                    </div>
                    <span class="text-[11px] shrink-0">{{ tc.status || 'done' }}</span>
                  </button>

                  <div v-if="hasToolDetail(tc) && expandedToolCallIds[tc.id]" class="px-3 pb-3 pt-0 space-y-2 border-t border-gray-700/30">
                    <pre v-if="shouldShowToolArguments(tc.toolName) && tc.query" class="text-[11px] text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-32 mt-2 p-2 rounded-lg bg-black/40 border border-white/10">{{ tc.query }}</pre>
                    <pre v-if="tc.result" class="text-[11px] text-zinc-200 overflow-x-auto whitespace-pre-wrap max-h-48 p-2 rounded-lg bg-black/40 border border-white/10">{{ unwrapToolResultEnvelope(tc.result) }}</pre>
                  </div>
                </div>
              </div>

              <!-- 模型失败等待重试：与主消息列表共用同一份提示实现 -->
              <ModelRetryNotice v-if="msg.modelRetry" :retry="msg.modelRetry" />

              <!-- 消息正文 -->
              <div
                :class="[
                  'p-4 rounded-2xl text-sm leading-relaxed border transition-colors shadow-2xs',
                  msg.role === 'user'
                    ? (isDark ? 'bg-cyan-950/20 border-cyan-500/30 text-cyan-100' : 'bg-[#eef4fd] border-blue-100 text-gray-900')
                    : (isDark ? 'bg-black/90 border-white/15 text-zinc-100 shadow-[0_0_20px_rgba(0,0,0,0.8)]' : 'bg-white border-zinc-200 text-gray-900')
                ]"
              >
                <MarkdownRenderer :content="msg.content" :is-dark="isDark" />
              </div>
            </div>
          </template>
          </div>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>
