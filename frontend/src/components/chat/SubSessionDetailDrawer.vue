<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { SubSessionVO, ChatMessage, ToolCallTrace } from '../../types/chat';
import { SessionAPI } from '../../services/session';
import { parseSessionMessages } from '../../utils/session';
import { formatClockTime } from '../../utils/format';
import { parseToolDiff } from '../../utils/toolDiff';
import { shouldShowToolArguments, resolveToolCategory } from '../../utils/toolMeta';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { isOk } from '../../utils/api';

const props = defineProps<{
  isOpen: boolean;
  subSession: SubSessionVO | null;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isLoading = ref(false);
const messages = ref<ChatMessage[]>([]);
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

const loadMessages = async () => {
  if (!props.subSession || !props.subSession.id) {
    messages.value = [];
    loadError.value = false;
    return;
  }

  isLoading.value = true;
  loadError.value = false;
  try {
    const res = await SessionAPI.messages(props.subSession.id, null, 100);
    if (isOk(res.code)) {
      messages.value = res.data?.records
        ? parseSessionMessages(res.data.records, String(props.subSession.id))
        : [];
    } else {
      // 接口返回失败：区别于「确实为空」，置失败态允许重试
      messages.value = [];
      loadError.value = true;
    }
  } catch (err) {
    console.error('加载子会话消息列表失败:', err);
    messages.value = [];
    loadError.value = true;
  } finally {
    isLoading.value = false;
  }
};

watch(
  () => [props.isOpen, props.subSession?.id],
  ([open]) => {
    if (open) {
      loadMessages();
    }
  },
  { immediate: true }
);

const displayAgentName = computed(() => {
  return props.subSession?.agentName || (props.subSession?.agentId ? `Agent #${props.subSession.agentId}` : '子代理');
});

const copyAllContent = () => {
  const text = messages.value
    .map(m => `${m.role === 'user' ? '【委派任务】' : '【子代理回复】'}:\n${m.content}`)
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
          'fixed inset-y-0 right-0 w-full max-w-2xl shadow-2xl z-50 flex flex-col border-l transition-colors',
          isDark ? 'bg-[#0f141c] border-[#222b3d] text-gray-100' : 'bg-white border-gray-200 text-gray-800'
        ]"
      >
        <!-- 抽屉头部 -->
        <div :class="['px-6 py-4 border-b flex items-center justify-between shrink-0', isDark ? 'border-[#222b3d] bg-[#141a24]' : 'border-gray-100 bg-gray-50/70']">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-400 flex items-center justify-center text-white shadow-sm shrink-0">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-semibold text-sm truncate">{{ displayAgentName }}</h3>
                <span :class="['text-[11px] px-2 py-0.5 rounded-full font-mono font-medium', isDark ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20' : 'bg-blue-50 text-blue-600 border border-blue-200']">
                  子会话 #{{ subSession?.id }}
                </span>
              </div>
              <p class="text-xs text-gray-400 truncate mt-0.5">
                {{ subSession?.name || subSession?.task || '子代理执行会话' }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <!-- 复制按钮 -->
            <button
              v-if="messages.length > 0"
              @click="copyAllContent"
              :class="['px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer', isDark ? 'border-[#2c374d] hover:bg-[#1f2838] text-gray-300' : 'border-gray-200 hover:bg-gray-100 text-gray-600']"
              :title="copied ? '已复制全部对话' : '复制全部对话'"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>{{ copied ? '已复制' : '复制对话' }}</span>
            </button>

            <!-- 关闭按钮 -->
            <button
              @click="emit('close')"
              :class="['p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-500/10 transition cursor-pointer']"
              title="关闭详情"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 会话状态与指标信息栏 -->
        <div :class="['px-6 py-2.5 border-b text-xs flex items-center justify-between gap-4 flex-wrap select-none', isDark ? 'border-[#222b3d] bg-[#121721] text-gray-400' : 'border-gray-100 bg-gray-50/40 text-gray-500']">
          <div class="flex items-center gap-4">
            <span class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>执行完成</span>
            </span>
          </div>
          <div v-if="subSession?.createTime" class="font-mono opacity-80 text-[11px]">
            创建于 {{ new Date(subSession.createTime).toLocaleString() }}
          </div>
        </div>

        <!-- 消息列表正文区域 -->
        <div class="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
          <!-- 加载中骨架屏 -->
          <div v-if="isLoading" class="py-12 flex flex-col items-center justify-center gap-3 text-gray-400">
            <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-xs font-medium">正在拉取子代理会话轨迹...</span>
          </div>

          <!-- 加载失败状态（区别于「确实为空」，可重试） -->
          <div v-else-if="loadError" class="py-16 text-center text-gray-400 text-xs flex flex-col items-center gap-3">
            <div class="w-12 h-12 rounded-full flex items-center justify-center bg-red-500/10 text-red-400">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span>子会话消息加载失败</span>
            <button
              type="button"
              @click="loadMessages"
              :class="['px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer', isDark ? 'border-[#2c374d] hover:bg-[#1f2838] text-gray-300' : 'border-gray-200 hover:bg-gray-100 text-gray-600']"
            >
              重试
            </button>
          </div>

          <!-- 空列表状态 -->
          <div v-else-if="messages.length === 0" class="py-16 text-center text-gray-400 text-xs">
            <div class="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center bg-gray-500/10 text-gray-400">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span>该子会话暂无独立消息记录</span>
          </div>

          <!-- 消息时序气泡 -->
          <template v-else>
            <div
              v-for="msg in messages"
              :key="msg.id"
              class="flex flex-col gap-2"
            >
              <!-- 角色标识与时间 -->
              <div class="flex items-center gap-2 text-xs text-gray-400 select-none">
                <span :class="['font-medium px-2 py-0.5 rounded text-[11px]', msg.role === 'user' ? (isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-700') : (isDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-50 text-purple-700')]">
                  {{ msg.role === 'user' ? '管理者指令 (Manager)' : displayAgentName }}
                </span>
                <span class="font-mono text-[11px]">{{ formatClockTime(msg.timestamp) }}</span>
              </div>

              <!-- 思考过程折叠 (CoT) -->
              <div v-if="msg.thoughtSteps?.length" class="pl-3 border-l-2 border-indigo-400/40 space-y-1.5 my-1">
                <button
                  type="button"
                  @click="toggleThought(msg.id)"
                  class="text-xs text-indigo-400 font-medium flex items-center gap-1.5 cursor-pointer hover:text-indigo-300 transition select-none"
                >
                  <svg :class="['w-3 h-3 text-indigo-400 transition-transform duration-200', expandedThoughtMsgIds[msg.id] ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  <span>Thought for</span>
                </button>
                <div v-if="expandedThoughtMsgIds[msg.id]">
                  <div v-for="step in msg.thoughtSteps" :key="step.id" class="text-xs text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap leading-relaxed pl-4">
                    {{ step.content }}
                  </div>
                </div>
              </div>

              <!-- 内部工具调用记录 (默认折叠) -->
              <div v-if="msg.toolCalls?.length" class="space-y-1.5 my-1">
                <div
                  v-for="tc in msg.toolCalls"
                  :key="tc.id"
                  :class="['rounded-xl border text-xs font-mono transition overflow-hidden', isDark ? 'border-[#222b3d] bg-[#121620]' : 'border-gray-200 bg-gray-50']"
                >
                  <button
                    type="button"
                    @click="toggleToolCall(tc.id)"
                    class="w-full p-2.5 flex items-center justify-between text-gray-400 hover:text-gray-200 transition cursor-pointer select-none text-left"
                  >
                    <div class="flex items-center gap-2 truncate min-w-0">
                      <svg
                        :class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200 shrink-0', expandedToolCallIds[tc.id] ? 'rotate-90' : '']"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="tc.status === 'failed' ? 'bg-rose-500' : tc.status === 'calling' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'"></span>
                      <span class="font-semibold text-gray-300 dark:text-gray-200 truncate">{{ resolveToolCategory(tc.toolName) }}</span>
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

                  <div v-if="expandedToolCallIds[tc.id]" class="px-3 pb-3 pt-0 space-y-2 border-t border-gray-700/30">
                    <pre v-if="shouldShowToolArguments(tc.toolName) && tc.query" class="text-[11px] text-gray-400 overflow-x-auto whitespace-pre-wrap max-h-32 mt-2 p-2 rounded-lg bg-black/20">{{ tc.query }}</pre>
                    <pre v-if="tc.result" class="text-[11px] text-gray-200 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-48 p-2 rounded-lg bg-black/20">{{ tc.result }}</pre>
                  </div>
                </div>
              </div>

              <!-- 消息正文 -->
              <div
                :class="[
                  'p-4 rounded-2xl text-sm leading-relaxed border transition-colors shadow-2xs',
                  msg.role === 'user'
                    ? (isDark ? 'bg-[#151c28] border-[#222c3d] text-blue-50' : 'bg-[#eef4fd] border-blue-100 text-gray-900')
                    : (isDark ? 'bg-[#121721] border-[#20293a] text-gray-100' : 'bg-white border-gray-200 text-gray-900')
                ]"
              >
                <MarkdownRenderer :content="msg.content" :is-dark="props.isDark" />
              </div>
            </div>
          </template>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>
