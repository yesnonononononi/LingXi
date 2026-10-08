
<template>
  <ScrollCursorLoader
    ref="scrollLoaderRef"
    v-bind="$attrs"
    class="scrollbar-thin relative flex flex-col flex-1 h-full"
    :style="{
      overflowY: messages && messages.length > 0 ? 'auto' : 'hidden'
    }"
    direction="top"
    :threshold="80"
    :hasMore="!isLoading && !!hasMore"
    :loading="isLoadingMore"
    loadingText="正在加载历史消息..."
    @load="emit('load')"
    @scroll="handleScroll"
  >
    <div :class="['flex-1 w-full space-y-3', compact ? 'px-3.5 py-4' : 'max-w-3xl mx-auto py-6 px-4']">
      <!-- 历史消息加载失败：可见失败态 + 重试 -->
      <div
        v-if="historyLoadError"
        :class="['flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs', isDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
      >
        <span>{{ historyLoadError }}</span>
        <button
          type="button"
          @click="emit('retryHistoryLoad')"
          :class="['px-2.5 py-1 rounded-lg border text-xs font-medium transition cursor-pointer shrink-0', isDark ? 'border-red-800 text-red-300 hover:bg-red-900/30' : 'border-red-300 text-red-600 hover:bg-red-100']"
        >
          重试
        </button>
      </div>

      <!-- 首次会话消息加载中 -->
      <div v-if="isLoading" class="flex flex-col items-center justify-center py-20 text-xs text-gray-400 gap-3 select-none">
        <svg class="animate-spin h-6 w-6 text-blue-500" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span class="tracking-wide">{{ loadingText || '正在加载对话历史...' }}</span>
      </div>

      <!-- 首次加载错误 -->
      <div v-else-if="loadError" class="py-8 text-center text-xs text-gray-400 space-y-2">
        <div class="text-red-400">{{ loadError }}</div>
        <button
          type="button"
          @click="emit('retryInitialLoad')"
          :class="['px-2.5 py-1 rounded-lg border text-xs cursor-pointer', isDark ? 'border-gray-700 hover:bg-gray-800 text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600']"
        >
          重试
        </button>
      </div>

      <!-- 空消息提示 -->
      <div v-else-if="!messages || messages.length === 0" class="py-12 text-center text-xs text-gray-400 select-none">
        暂无消息
      </div>

      <!-- 消息列表渲染 -->
      <template v-else>
        <ChatMessageItem
          v-for="(msg, idx) in messages"
          :key="msg.id"
          :message="msg"
          :subSessions="subSessions"
          :sessionId="sessionId"
          :isDark="isDark"
          :turn="turnMap?.get(msg)?.turn ?? null"
          :isGroupTail="turnMap ? (turnMap.get(msg)?.isGroupTail ?? false) : undefined"
          :isLastAssistant="idx === computedLastAssistantIndex"
          :isSending="isSending"
          @selectSubSession="(id) => emit('selectSubSession', id)"
          @resume="(sid) => emit('resume', sid)"
        />
      </template>
    </div>
  </ScrollCursorLoader>
</template>


<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage, ChatTurn, SubSessionVO } from '../../types/chat';
import ScrollCursorLoader from '../common/ScrollCursorLoader.vue';
import ChatMessageItem from './ChatMessageItem.vue';

const props = defineProps<{
  messages: ChatMessage[];
  turnMap?: Map<ChatMessage, { turn: ChatTurn | null; isGroupTail: boolean }>;
  sessionId?: string | number;
  subSessions?: SubSessionVO[];
  isDark?: boolean;
  isSending?: boolean;
  isLoading?: boolean;
  loadingText?: string;
  loadError?: string | null;
  historyLoadError?: string | null;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  lastAssistantIndex?: number;
  compact?: boolean;
}>();

const emit = defineEmits<{
  (e: 'load'): void;
  (e: 'retryHistoryLoad'): void;
  (e: 'retryInitialLoad'): void;
  (e: 'scroll', event: Event): void;
  (e: 'selectSubSession', id: string | number): void;
  (e: 'resume', sessionId?: string | number): void;
}>();

const scrollLoaderRef = ref<InstanceType<typeof ScrollCursorLoader> | null>(null);

const computedLastAssistantIndex = computed(() => {
  if (props.lastAssistantIndex !== undefined) return props.lastAssistantIndex;
  const msgs = props.messages;
  if (!msgs || msgs.length === 0) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return i;
  }
  return -1;
});

const handleScroll = (e: Event) => {
  emit('scroll', e);
};

defineExpose({
  scrollToBottom: (behavior?: ScrollBehavior) => scrollLoaderRef.value?.scrollToBottom(behavior),
  scrollToTop: (behavior?: ScrollBehavior) => scrollLoaderRef.value?.scrollToTop(behavior),
  beforePrepend: () => scrollLoaderRef.value?.beforePrepend(),
  afterPrepend: () => scrollLoaderRef.value?.afterPrepend(),
  restoreScrollPosition: () => scrollLoaderRef.value?.restoreScrollPosition(),
  getContainer: () => scrollLoaderRef.value?.getContainer(),
  containerRef: computed(() => scrollLoaderRef.value?.containerRef),
  scrollLoaderRef
});
</script>
