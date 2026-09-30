<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { SubSessionVO, SubItemStatus, ToolCallTrace, ChatMessage, ExecutionSummary } from '../../types/chat';
import { formatTokens, formatDuration, formatClockTime } from '../../utils/format';
import { parseToolDiff } from '../../utils/toolDiff';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ScrollCursorLoader from '../common/ScrollCursorLoader.vue';

export interface SubSessionItem {
  id: string | number;
  agentId?: string | number;
  agentName: string;
  task: string;
  prompt?: string;
  result?: string;
  /** 展示态：由后端 runStatus + lastOutcome 派生（见 utils/subSessionStatus.ts）；unknown 表示无法判定 */
  status: SubItemStatus;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  subSession?: SubSessionVO;
  tc?: ToolCallTrace;
}

/** 状态文案：7 态如实显示；idle/unknown 不再伪装成"完成" */
const statusLabel = (status: SubItemStatus, long = false): string => {
  if (status === 'running') return long ? '正在执行...' : '执行中';
  if (status === 'suspended') return long ? '等待恢复' : '待恢复';
  if (status === 'failed') return long ? '执行异常' : '失败';
  if (status === 'cancelled') return long ? '已取消' : '取消';
  if (status === 'completed') return long ? '协同完成' : '完成';
  if (status === 'idle') return long ? '空闲' : '空闲';
  return long ? '状态未知' : '未知';
};

const props = defineProps<{
  items: SubSessionItem[];
  activeSubId: string | number | null;
  activeSubSession?: SubSessionVO | null;
  subMessages?: ChatMessage[];
  /**
   * 子会话消息 → 所属回答组执行摘要 / 是否组尾 映射（与主会话同一分组规则）。
   * 仅组尾展示一次执行元信息；缺失或 execution 为 null 时隐藏，不伪造统计。
   */
  executionMap?: Map<string, { execution: ExecutionSummary | null; isGroupTail: boolean }>;
  isLoadingMessages?: boolean;
  messagesError?: string;
  hasMoreSubMessages?: boolean;
  isLoadingMoreSubMessages?: boolean;
  isDark?: boolean;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectOption', id: string | number | null): void;
  (e: 'toggleOpen'): void;
  (e: 'retryMessages'): void;
  (e: 'loadMoreMessages'): void;
}>();

const subScrollLoaderRef = ref<InstanceType<typeof ScrollCursorLoader> | null>(null);

/** 执行状态中文文案（仅用于回答组末条的执行元信息行）。 */
const execStatusLabel = (status: ExecutionSummary['status']): string => {
  const labels: Record<string, string> = {
    CREATED: '已创建',
    RUNNING: '执行中',
    SUSPENDED: '已挂起',
    COMPLETED: '已完成',
    FAILED: '已失败',
    CANCELLED: '已取消'
  };
  return labels[status] ?? status;
};

/**
 * 回答组执行元信息（仅组尾、且有摘要时非空），模板按 msg.id 取用。
 * 每个回答组只展示一次；token 为 null 时显示「暂无统计」，绝不当 0。
 */
const executionFooters = computed(() => {
  const out = new Map<string, { model: string; status: string; tokens: string; duration: string }>();
  const map = props.executionMap;
  if (!map) return out;
  for (const [msgId, info] of map) {
    if (!info.isGroupTail || !info.execution) continue;
    const e = info.execution;
    const total = e.totalTokens != null
      ? e.totalTokens
      : (e.inputTokens != null && e.outputTokens != null ? e.inputTokens + e.outputTokens : null);
    out.set(msgId, {
      model: (e.modelName || '').trim(),
      status: execStatusLabel(e.status),
      tokens: total == null ? '暂无统计' : formatTokens(total),
      duration: e.elapsedMs == null ? '暂无统计' : formatDuration(e.elapsedMs)
    });
  }
  return out;
});

// 复制反馈（子会话 id 键控；见 composables/useCopyFeedback.ts）
const { copiedKey: copiedId, copy: copyRaw } = useCopyFeedback();
const expandedTaskId = ref<Record<string, boolean>>({});
// thinking 思考过程：默认折叠
const expandedThoughtMsgIds = ref<Record<string, boolean>>({});
// toolCalls 工具调用：默认折叠
const expandedToolCallIds = ref<Record<string, boolean>>({});
// intermediate ai 中间过程：默认折叠
const expandedIntermediateMsgIds = ref<Record<string, boolean>>({});

const toggleThought = (msgId: string) => {
  expandedThoughtMsgIds.value[msgId] = !expandedThoughtMsgIds.value[msgId];
};

const toggleToolCall = (tcId: string) => {
  expandedToolCallIds.value[tcId] = !expandedToolCallIds.value[tcId];
};

const toggleIntermediate = (msgId: string) => {
  expandedIntermediateMsgIds.value[msgId] = !expandedIntermediateMsgIds.value[msgId];
};

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

const activeItem = computed(() => {
  if (props.activeSubId === null) return null;
  return props.items.find(it => String(it.id) === String(props.activeSubId)) || null;
});

// formatTokens 已收敛到 utils/format.ts
const handleCopyResult = (text: string, id: string | number) => {
  void copyRaw(text, id);
};

const copySubConversation = () => {
  if (!props.subMessages?.length) return;
  const text = props.subMessages
    .map(m => `${m.role === 'user' ? '【管理者指令】' : `【${activeItem.value?.agentName || '子代理'}】`}:\n${m.content}`)
    .join('\n\n');
  void copyRaw(text, 'sub-conversation');
};

const toggleTaskExpand = (id: string | number) => {
  const key = String(id);
  expandedTaskId.value[key] = !expandedTaskId.value[key];
};

/** 自动平滑滚动到底部（点击即滚动、新内容即滚动） */
const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
  nextTick(() => {
    subScrollLoaderRef.value?.scrollToBottom(behavior);
  });
};

const handleSelectCard = (id: string | number | null) => {
  emit('selectOption', id);
  if (id !== null) {
    scrollToBottom('auto');
    setTimeout(() => scrollToBottom('auto'), 50);
  }
};

watch(() => props.activeSubId, (newId) => {
  if (newId !== null) {
    scrollToBottom('auto');
    setTimeout(() => scrollToBottom('auto'), 50);
  }
});

watch(() => props.isLoadingMessages, (loading, prevLoading) => {
  if (prevLoading && !loading) {
    scrollToBottom('auto');
    setTimeout(() => scrollToBottom('auto'), 50);
  }
});

watch(() => props.subMessages?.length, (newLen, oldLen) => {
  if (newLen && (!oldLen || newLen > oldLen)) {
    if (!props.isLoadingMoreSubMessages) {
      scrollToBottom('auto');
    }
  }
});
</script>

<template>
  <!-- 1. 折叠状态：右侧边缘轻量标签按钮 (对齐用户截图右侧蓝底弧形把手) -->
  <div v-if="!isOpen" class="fixed right-0 top-24 z-30 flex items-center">
    <button
      @click="emit('toggleOpen')"
      :class="[
        'px-2.5 py-2 rounded-l-2xl border-y border-l shadow-md flex items-center gap-1.5 transition-all hover:pr-3.5 cursor-pointer select-none text-xs font-medium',
        isDark
          ? 'bg-[#151c28]/95 border-[#28364f] text-blue-300 hover:bg-[#1c2637]'
          : 'bg-blue-50/95 border-blue-200 text-blue-700 hover:bg-blue-100'
      ]"
      title="展开子代理协作轨迹与选项"
    >
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      <div class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
      <span>子代理 ({{ items.length }})</span>
    </button>
  </div>

  <!-- 2. 展开状态：位于右侧红框位置的子 Agent 轨迹与标签面板 -->
  <aside
    v-else
    :class="[
      'w-88 sm:w-96 lg:w-[420px] xl:w-[460px] shrink-0 border-l flex flex-col h-full z-20 backdrop-blur-md transition-all duration-300 ease-in-out select-none',
      isDark ? 'bg-[#0e131c]/95 border-[#1f2838] text-gray-200' : 'bg-gray-50/90 border-gray-200 text-gray-800'
    ]"
  >
    <!-- 2.1 当选中子会话时：展示该子代理的专属任务卡片与消息流 (图三右侧排版) -->
    <div v-if="activeItem" class="flex flex-col h-full overflow-hidden">
      <!-- 顶部：标题、状态与收束/关闭按钮 -->
      <div :class="['px-4 py-3 border-b flex items-center justify-between shrink-0', isDark ? 'border-[#1d2637] bg-[#131924]/80' : 'border-gray-200/80 bg-white/80']">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-7 h-7 rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-xs shrink-0 font-medium text-xs">
            {{ activeItem.agentName.substring(0, 1) }}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <h3 class="text-xs font-semibold truncate">{{ activeItem.agentName }} 的任务</h3>
              <span :class="['text-[10px] px-1.5 py-0.2 rounded-full font-mono', isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700']">
                #{{ activeItem.id }}
              </span>
            </div>
            <p class="text-[11px] text-gray-400 truncate mt-0.5">{{ activeItem.task || '子会话任务详情' }}</p>
          </div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <!-- 复制对话 -->
          <button
            v-if="subMessages && subMessages.length > 0"
            @click="copySubConversation"
            :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-[#253247] hover:bg-[#1a2333]' : 'border-gray-200 hover:bg-gray-100']"
            :title="copiedId === 'sub-conversation' ? '已复制' : '复制对话'"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          <!-- 收起/关闭子会话卡片按钮 (返回主会话列表) -->
          <button
            @click="emit('selectOption', null)"
            :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-[#253247] hover:bg-[#1a2333]' : 'border-gray-200 hover:bg-gray-100']"
            title="关闭子会话卡片"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <!-- 收起整个侧边面板 -->
          <button
            @click="emit('toggleOpen')"
            :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-[#253247] hover:bg-[#1a2333]' : 'border-gray-200 hover:bg-gray-100']"
            title="收起侧边面板"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 状态与用量指标栏 -->
      <div :class="['px-4 py-2 border-b text-[11px] flex items-center justify-between gap-2 select-none shrink-0', isDark ? 'border-[#1b2333] bg-[#111722]/60 text-gray-400' : 'border-gray-100 bg-gray-50/60 text-gray-500']">
        <span class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full" :class="activeItem.status === 'running' ? 'bg-amber-400 animate-ping' : activeItem.status === 'completed' ? 'bg-emerald-500' : 'bg-gray-400'"></span>
          <span>{{ statusLabel(activeItem.status) }}</span>
        </span>
        <span v-if="activeItem.totalTokens" class="font-mono text-[10px]">
          Token: {{ formatTokens(activeItem.totalTokens) }}
        </span>
      </div>

      <!-- 子会话消息轨迹正文 (从下而上游标分页 + 自动吸底 + 工具/thinking默认折叠) -->
      <div class="flex-1 overflow-hidden relative flex flex-col min-h-0 select-text">
        <div v-if="isLoadingMessages" class="py-12 flex flex-col items-center justify-center gap-2 text-gray-400 text-xs">
          <svg class="animate-spin h-5 w-5 text-blue-500" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>正在加载子代理会话轨迹...</span>
        </div>

        <div v-else-if="messagesError" class="py-8 text-center text-xs text-gray-400 space-y-2">
          <div class="text-red-400">{{ messagesError }}</div>
          <button @click="emit('retryMessages')" class="px-2.5 py-1 rounded-lg border text-xs cursor-pointer">重试</button>
        </div>

        <ScrollCursorLoader
          v-else
          ref="subScrollLoaderRef"
          class="scrollbar-thin relative flex-1 h-full overflow-y-auto"
          direction="top"
          :threshold="60"
          :hasMore="hasMoreSubMessages"
          :loading="isLoadingMoreSubMessages"
          loadingText="正在加载历史消息..."
          @load="emit('loadMoreMessages')"
        >
          <div v-if="!subMessages || subMessages.length === 0" class="py-12 text-center text-xs text-gray-400">
            暂无消息
          </div>

          <div v-else class="p-3.5 space-y-3.5">
            <div v-for="msg in subMessages" :key="msg.id" class="flex flex-col gap-1.5">
              <!-- 角色与时间 -->
              <div class="flex items-center gap-2 text-xs text-gray-400 select-none">
                <span :class="['font-medium px-2 py-0.5 rounded text-[11px]', msg.role === 'user' ? (isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-700') : (isDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-50 text-purple-700')]">
                  {{ msg.role === 'user' ? (activeSubSession?.name ? activeSubSession.name : '管理者指令') : activeItem.agentName }}
                </span>
                <span class="font-mono text-[10px]">{{ formatClockTime(msg.timestamp) }}</span>
              </div>

              <!-- 思维链思考过程 (CoT，默认折叠) -->
              <div v-if="msg.thoughtSteps?.length" class="pl-2.5 border-l-2 border-indigo-400/40 space-y-1 my-0.5">
                <button
                  type="button"
                  @click="toggleThought(msg.id)"
                  class="text-xs text-indigo-400 font-medium flex items-center gap-1.5 cursor-pointer hover:text-indigo-300 transition select-none"
                >
                  <svg :class="['w-3 h-3 text-indigo-400 transition-transform duration-200', expandedThoughtMsgIds[msg.id] ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  <span>深度思考</span>
                  <span class="text-[10px] text-indigo-300/60 font-mono">({{ msg.thoughtSteps.length }} 步)</span>
                </button>
                <div v-if="expandedThoughtMsgIds[msg.id]" class="mt-1 space-y-1">
                  <div v-for="step in msg.thoughtSteps" :key="step.id" class="text-[11px] text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap leading-relaxed pl-3 select-text">
                    {{ step.content }}
                  </div>
                </div>
              </div>

              <!-- 中间轮次过程说明 (默认折叠) -->
              <div v-if="msg.aiMessages?.length" class="pl-2.5 border-l-2 border-blue-400/40 space-y-1 my-0.5">
                <button
                  type="button"
                  @click="toggleIntermediate(msg.id)"
                  class="text-xs text-blue-400 font-medium flex items-center gap-1.5 cursor-pointer hover:text-blue-300 transition select-none"
                >
                  <svg :class="['w-3 h-3 text-blue-400 transition-transform duration-200', expandedIntermediateMsgIds[msg.id] ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  <span>过程记录</span>
                  <span class="text-[10px] text-blue-300/60 font-mono">({{ msg.aiMessages.length }} 条)</span>
                </button>
                <div v-if="expandedIntermediateMsgIds[msg.id]" class="mt-1 space-y-1 pl-3">
                  <div v-for="aim in msg.aiMessages" :key="aim.id" class="text-[11px] text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap leading-relaxed select-text">
                    {{ aim.text }}
                  </div>
                </div>
              </div>

              <!-- 工具调用轨迹 (默认折叠) -->
              <div v-if="msg.toolCalls?.length" class="space-y-1.5 my-0.5">
                <div
                  v-for="tc in msg.toolCalls"
                  :key="tc.id"
                  :class="['rounded-xl border text-xs font-mono transition overflow-hidden', isDark ? 'border-[#222b3d] bg-[#121620]' : 'border-gray-200 bg-gray-50']"
                >
                  <!-- 顶部折叠标题栏（单行轻量展示，默认折叠） -->
                  <button
                    type="button"
                    @click="toggleToolCall(tc.id)"
                    class="w-full p-2 flex items-center justify-between text-gray-400 hover:text-gray-200 transition cursor-pointer select-none text-left"
                  >
                    <div class="flex items-center gap-1.5 truncate min-w-0">
                      <svg
                        :class="['w-3 h-3 text-gray-400 transition-transform duration-200 shrink-0', expandedToolCallIds[tc.id] ? 'rotate-90' : '']"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="tc.status === 'failed' ? 'bg-rose-500' : tc.status === 'calling' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'"></span>
                      <span class="font-semibold text-gray-300 dark:text-gray-200 truncate">{{ tc.toolName }}</span>
                      <span v-if="getToolDiffStat(tc)" class="inline-flex items-center gap-1 font-mono text-[10px] font-medium leading-none ml-1 shrink-0">
                        <span v-if="getToolDiffStat(tc)!.plusLines !== undefined && getToolDiffStat(tc)!.plusLines! > 0" class="text-[#088f50] dark:text-emerald-400">+{{ getToolDiffStat(tc)!.plusLines }}</span>
                        <span v-if="getToolDiffStat(tc)!.minusLines !== undefined && getToolDiffStat(tc)!.minusLines! > 0" class="text-[#b42c3f] dark:text-rose-400">-{{ getToolDiffStat(tc)!.minusLines }}</span>
                      </span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <span class="text-[10px]">{{ tc.status || 'done' }}</span>
                    </div>
                  </button>

                  <!-- 展开后的工具调用详情 -->
                  <div v-if="expandedToolCallIds[tc.id]" class="px-2 pb-2 pt-0 space-y-1.5 border-t border-gray-700/30">
                    <div v-if="tc.query" class="mt-1">
                      <div class="text-[10px] text-gray-500 mb-0.5">输入/参数:</div>
                      <pre class="text-[10px] text-gray-400 overflow-x-auto whitespace-pre-wrap max-h-32 p-1.5 rounded-lg bg-black/20 select-text">{{ tc.query }}</pre>
                    </div>
                    <div v-if="tc.result" class="mt-1">
                      <div class="flex items-center justify-between text-[10px] text-gray-500 mb-0.5">
                        <span>输出结果:</span>
                        <button
                          type="button"
                          @click.stop="handleCopyResult(tc.result, tc.id)"
                          class="hover:text-gray-300 transition cursor-pointer"
                        >
                          {{ copiedId === tc.id ? '已复制' : '复制' }}
                        </button>
                      </div>
                      <pre class="text-[10px] text-gray-200 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-48 p-1.5 rounded-lg bg-black/20 select-text">{{ tc.result }}</pre>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 消息正文 -->
              <div
                v-if="msg.content"
                :class="[
                  'p-3 rounded-2xl text-xs sm:text-sm leading-relaxed border transition-colors shadow-2xs select-text',
                  msg.role === 'user'
                    ? (isDark ? 'bg-[#151c28] border-[#222c3d] text-blue-50' : 'bg-[#eef4fd] border-blue-100 text-gray-900')
                    : (isDark ? 'bg-[#121721] border-[#20293a] text-gray-100' : 'bg-white border-gray-200 text-gray-900')
                ]"
              >
                <MarkdownRenderer :content="msg.content" :is-dark="isDark" />
              </div>

              <!-- 执行元信息：每个回答组仅末条展示一次（总历时包含等待时间；无摘要则隐藏，不显示成 0） -->
              <div
                v-if="executionFooters.get(msg.id)"
                class="flex flex-wrap items-center gap-2 text-[10px] text-gray-400 select-none pl-0.5 pt-0.5"
                title="总历时包含暂停与等待审批的时间"
              >
                <span v-if="executionFooters.get(msg.id)!.model" class="font-mono">{{ executionFooters.get(msg.id)!.model }}</span>
                <span>{{ executionFooters.get(msg.id)!.status }}</span>
                <span>用量 {{ executionFooters.get(msg.id)!.tokens }}</span>
                <span>用时 {{ executionFooters.get(msg.id)!.duration }}(含等待)</span>
              </div>
            </div>
          </div>
        </ScrollCursorLoader>
      </div>

      <!-- 底部操作：返回全部团队成员 -->
      <div :class="['p-3 border-t text-xs shrink-0 flex items-center justify-between', isDark ? 'border-[#1b2333] bg-[#111722]/80' : 'border-gray-200 bg-white']">
        <button
          @click="emit('selectOption', null)"
          :class="['w-full py-1.5 rounded-xl border flex items-center justify-center gap-1.5 text-xs font-medium transition cursor-pointer', isDark ? 'border-[#253247] hover:bg-[#1a2333] text-gray-300' : 'border-gray-200 hover:bg-gray-100 text-gray-600']"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          <span>查看全部团队成员 ({{ items.length }})</span>
        </button>
      </div>
    </div>

    <!-- 2.2 未选中具体子会话时：展示全部成员 Options 概览列表 -->
    <div v-else class="flex flex-col h-full overflow-hidden">
      <!-- 面板顶栏：协作状态与折叠操作 -->
      <div :class="['px-4 py-3 border-b flex items-center justify-between shrink-0', isDark ? 'border-[#1d2637] bg-[#131924]/80' : 'border-gray-200/80 bg-white/80']">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-7 h-7 rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-xs shrink-0">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <h3 class="text-xs font-semibold truncate">团队协同成员</h3>
              <span :class="['px-1.5 py-0.2 rounded-full text-[10px] font-mono font-medium', isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700']">
                {{ items.length }}
              </span>
            </div>
            <p class="text-[11px] text-gray-400 truncate">点击成员卡片展开独立执行轨迹</p>
          </div>
        </div>

        <!-- 折叠面板按钮 -->
        <button
          @click="emit('toggleOpen')"
          :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-[#253247] hover:bg-[#1a2333]' : 'border-gray-200 hover:bg-gray-100']"
          title="收起侧边面板"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <!-- 滚动内容区 -->
      <div class="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
        <!-- 子 Agent Options 选项卡列表 (对齐用户截图 Image 2 样式) -->
        <div
          v-for="(it, idx) in items"
          :key="it.id"
          @click="handleSelectCard(it.id)"
          :class="[
            'p-3 rounded-2xl border transition-all cursor-pointer select-none space-y-2',
            String(activeSubId) === String(it.id)
              ? (isDark ? 'border-blue-500 bg-blue-600/15 ring-1 ring-blue-500/40 shadow-sm' : 'border-blue-400 bg-blue-50/70 ring-1 ring-blue-300 shadow-sm')
              : (isDark ? 'border-[#222d40] bg-[#121824]/70 hover:border-blue-500/40 hover:bg-[#161e2e]' : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/30')
          ]"
        >
          <!-- 头部标签行：编号、名称、状态、Token -->
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <!-- 编号徽章 -->
              <div class="w-6 h-6 rounded-lg bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0 shadow-2xs">
                #{{ idx + 1 }}
              </div>
              <span class="font-semibold text-xs truncate" :class="String(activeSubId) === String(it.id) ? (isDark ? 'text-blue-300' : 'text-blue-800') : ''">
                {{ it.agentName }}
              </span>
            </div>

            <!-- 状态标签指示灯 -->
            <span
              :class="[
                'px-1.5 py-0.5 rounded-full text-[10px] font-medium flex items-center gap-1 shrink-0',
                (it.status === 'idle' || it.status === 'unknown') ? (isDark ? 'bg-gray-500/15 text-gray-400 border border-gray-500/30' : 'bg-gray-50 text-gray-500 border border-gray-200') :
                it.status === 'running' ? (isDark ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'bg-amber-50 text-amber-600 border border-amber-200') :
                it.status === 'suspended' ? (isDark ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' : 'bg-blue-50 text-blue-600 border border-blue-200') :
                (it.status === 'failed' || it.status === 'cancelled') ? (isDark ? 'bg-red-500/15 text-red-400 border border-red-500/30' : 'bg-red-50 text-red-600 border border-red-200') :
                (isDark ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-emerald-50 text-emerald-600 border border-emerald-200')
              ]"
            >
              <span
                :class="[
                  'w-1.5 h-1.5 rounded-full',
                  (it.status === 'idle' || it.status === 'unknown') ? 'bg-gray-400' :
                  it.status === 'running' ? 'bg-amber-400 animate-ping' :
                  it.status === 'suspended' ? 'bg-blue-400' :
                  (it.status === 'failed' || it.status === 'cancelled') ? 'bg-red-500' : 'bg-emerald-500'
                ]"
              ></span>
              <span>{{ statusLabel(it.status) }}</span>
            </span>
          </div>

          <!-- 任务目标标签 (指派任务) -->
          <div
            @click.stop="toggleTaskExpand(it.id)"
            :class="['p-2 rounded-xl text-xs space-y-1 cursor-pointer', isDark ? 'bg-[#0d121a]' : 'bg-gray-50']"
            title="点击展开/收起完整任务"
          >
            <div class="flex items-center justify-between">
              <span class="px-1.5 py-0.2 rounded text-[10px] font-medium bg-blue-500/15 text-blue-500">
                指派任务
              </span>
              <span v-if="it.totalTokens" class="text-[10px] font-mono text-gray-400">
                ⚡ {{ formatTokens(it.totalTokens) }}
              </span>
            </div>
            <p :class="['text-xs text-gray-500 dark:text-gray-400 leading-relaxed', !expandedTaskId[String(it.id)] ? 'line-clamp-2' : 'whitespace-pre-wrap']">
              {{ it.task }}
            </p>
          </div>

          <!-- 底部操作与展示状态 -->
          <div class="flex items-center justify-between pt-1 text-xs">
            <div class="flex items-center gap-1">
              <span
                v-if="String(activeSubId) === String(it.id)"
                class="text-[11px] font-medium text-blue-500 flex items-center gap-1"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
                </svg>
                右侧已展开详情
              </span>
              <span
                v-else
                class="text-[11px] text-gray-400 hover:text-blue-500 flex items-center gap-1"
              >
                <span>点击展开独立轨迹</span>
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </span>
            </div>

            <!-- 复制产出按钮 -->
            <button
              v-if="it.result"
              @click.stop="handleCopyResult(it.result, it.id)"
              :class="['p-1 rounded-lg border text-gray-400 hover:text-gray-200 transition cursor-pointer', isDark ? 'border-[#29354d] hover:bg-[#1d273a]' : 'border-gray-200 hover:bg-gray-100']"
              :title="copiedId === it.id ? '已复制产出文本' : '复制产出'"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>
