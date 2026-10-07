<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue';
import type { SubSessionVO, SubItemStatus, ToolCallTrace, ChatMessage, ChatTurn } from '../../types/chat';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import ChatMessageList from './ChatMessageList.vue';

/** 默认及最小宽度配置 */
const DEFAULT_PANEL_WIDTH = 460;
const MIN_PANEL_WIDTH = 320;

const resolveStoredWidth = (): number => {
  try {
    const val = localStorage.getItem('lingxi-sub-panel-width');
    if (val) {
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed >= MIN_PANEL_WIDTH) {
        return parsed;
      }
    }
  } catch {
    // 忽略异常
  }
  return DEFAULT_PANEL_WIDTH;
};

const panelWidth = ref(resolveStoredWidth());
const isDragging = ref(false);

let startX = 0;
let startWidth = 0;

const onMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  const deltaX = startX - e.clientX;
  const maxAllowedWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 400);
  const nextWidth = Math.min(Math.max(startWidth + deltaX, MIN_PANEL_WIDTH), maxAllowedWidth);
  panelWidth.value = nextWidth;
};

const onMouseUp = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  try {
    localStorage.setItem('lingxi-sub-panel-width', String(panelWidth.value));
  } catch {
    // 忽略异常
  }
};

const startResize = (e: MouseEvent) => {
  e.preventDefault();
  isDragging.value = true;
  startX = e.clientX;
  startWidth = panelWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};

const handleResetWidth = () => {
  panelWidth.value = DEFAULT_PANEL_WIDTH;
  try {
    localStorage.setItem('lingxi-sub-panel-width', String(DEFAULT_PANEL_WIDTH));
  } catch {
    // 忽略异常
  }
};

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

/** 距底部多少像素以内仍视为「用户在跟随底部」（与主列表 scrollToBottomIfAuto 同款意图判定） */
const NEAR_BOTTOM_THRESHOLD_PX = 120;

export interface SubSessionItem {
  id: string | number;
  agentId?: string | number;
  agentName: string;
  task: string;
  prompt?: string;
  result?: string;
  /** 展示态：由后端 runStatus + lastOutcome 派生（见 utils/subSessionStatus.ts）；unknown 表示无法判定 */
  status: SubItemStatus;
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
  turnMap?: Map<string, { turn: ChatTurn | null; isGroupTail: boolean }>;
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

const subScrollLoaderRef = ref<InstanceType<typeof ChatMessageList> | null>(null);

// 复制反馈（子会话 id 键控；见 composables/useCopyFeedback.ts）
const { copiedKey: copiedId, copy: copyRaw } = useCopyFeedback();
const expandedTaskId = ref<Record<string, boolean>>({});

const handleCopyResult = (text: string, id: string | number) => {
  void copyRaw(text, id);
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

/**
 * 用户是否「贴底跟随」：以最近一次滚动事件时的位置为准（滚动意图），而不是读取瞬时距离——
 * 大块新内容（新工具卡、长气泡）插入瞬间 scrollHeight 先变大，瞬时判定会误判为「用户已上翻」。
 * 程序化 scrollToBottom 触发的滚动事件会把标志重新置 true，不影响跟随。
 */
let stickToBottom = true;
const handleSubListScroll = () => {
  const container = subScrollLoaderRef.value?.getContainer?.();
  if (!container) return;
  stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
};

/** 仅在用户未上翻时跟随到底部 */
const scrollToBottomIfFollowing = () => {
  if (!stickToBottom) return;
  scrollToBottom('auto');
};

const handleSelectCard = (id: string | number | null) => {
  emit('selectOption', id);
  if (id !== null) {
    stickToBottom = true;
    scrollToBottom('auto');
    setTimeout(() => scrollToBottom('auto'), 50);
  }
};

watch(() => props.activeSubId, (newId) => {
  if (newId !== null) {
    stickToBottom = true;
    scrollToBottom('auto');
    setTimeout(() => scrollToBottom('auto'), 50);
  }
});

/**
 * 流式跟随：子会话的流式更新走「按 id 原位替换」，消息条数不变，
 * 只 watch length 会漏掉整段流式期间的内容增长（气泡越长越看不到底部）。
 * 这里对「条数 + 末条消息的内容签名」建 computed 观察流式活跃度，
 * 并在用户未上翻时才跟随到底部。
 */
const lastMessageActivity = computed(() => {
  const msgs = props.subMessages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  const steps = last.thoughtSteps || [];
  const lastStepLen = steps.length > 0 ? (steps[steps.length - 1].content?.length ?? 0) : 0;
  return [
    msgs.length,
    last.id,
    last.content?.length ?? 0,
    steps.length,
    lastStepLen,
    last.toolCalls?.length ?? 0,
    last.aiMessages?.length ?? 0,
    last.isComplete ? 1 : 0
  ].join('|');
});

watch(lastMessageActivity, () => {
  scrollToBottomIfFollowing();
});

const activeItem = computed(() => {
  if (props.activeSubId === null) return null;
  return props.items.find(it => String(it.id) === String(props.activeSubId)) || null;
});

defineExpose({
  scrollToBottom
});
</script>

<template>
  <!-- 1. 折叠状态：右侧贴边胶囊按钮 (点击展开) -->
  <Transition name="sub-panel-tab">
  <div
    v-if="!isOpen"
    class="absolute right-0 top-1/2 -translate-y-1/2 z-30 transition-transform duration-300"
  >
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
  </Transition>

  <!-- 2. 展开状态：位于右侧的子 Agent 轨迹与标签面板 (支持左边缘拖拽调整宽度) -->
  <Transition name="sub-panel">
  <div
    v-if="isOpen"
    class="sub-panel-shell relative shrink-0 h-full"
    :class="{ 'is-resizing': isDragging }"
    :style="{ '--sub-panel-width': `${panelWidth}px` }"
  >
  <aside
    :style="{ width: `${panelWidth}px` }"
    :class="[
      'relative shrink-0 border-l flex flex-col h-full z-20 backdrop-blur-md select-none',
      isDark ? 'bg-[#09090b]/95 border-white/[0.06] text-zinc-200' : 'bg-gray-50/90 border-gray-200 text-gray-800'
    ]"
  >
    <!-- 左边缘拖拽分割条 (Resize Handle) -->
    <div
      class="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize z-40 group flex items-center justify-center select-none"
      title="拖拽调节主会话与子会话宽度（双击复原）"
      @mousedown="startResize"
      @dblclick="handleResetWidth"
    >
      <!-- 高亮中线指示器 -->
      <div
        class="w-[2px] h-full transition-colors duration-150"
        :class="[
          isDragging
            ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]'
            : (isDark ? 'group-hover:bg-blue-400/80 bg-transparent' : 'group-hover:bg-blue-500/80 bg-transparent')
        ]"
      />
    </div>
    <!-- 2.1 当选中子会话时：展示该子代理的专属任务卡片与消息流 (图二/图三右侧排版) -->
    <div v-if="activeItem" class="flex flex-col h-full overflow-hidden">
      <!-- 顶部：标题与收束按钮 (去掉头像，名字为纯agentName无后缀，仅保留右侧向右按钮) -->
      <div :class="['px-4 py-3 border-b flex items-center justify-between shrink-0', isDark ? 'border-white/[0.06] bg-[#0d0e12]/80' : 'border-gray-200/80 bg-white/80']">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <h3 class="text-xs font-semibold truncate">{{ activeItem.agentName }}</h3>
            </div>
            <p v-if="activeItem.task" class="text-[11px] text-gray-400 dark:text-zinc-500 truncate mt-0.5">{{ activeItem.task }}</p>
          </div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <!-- 返回成员列表：清空选中子会话，面板回到成员概览（此前只能收起整个面板，回不去列表） -->
          <button
            @click="emit('selectOption', null)"
            :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-blue-500', isDark ? 'border-white/[0.08] hover:bg-white/[0.06]' : 'border-gray-200 hover:bg-blue-50']"
            title="返回成员列表"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <!-- 收起整个侧边面板按钮 -->
          <button
            @click="emit('toggleOpen')"
            :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-white/[0.08] hover:bg-white/[0.06]' : 'border-gray-200 hover:bg-gray-100']"
            title="收起侧边面板"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 状态与用量指标栏 -->
      <div :class="['px-4 py-2 border-b text-[11px] flex items-center justify-between gap-2 select-none shrink-0', isDark ? 'border-white/[0.06] bg-[#09090b]/60 text-zinc-400' : 'border-gray-100 bg-gray-50/60 text-gray-500']">
        <span class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full" :class="activeItem.status === 'running' ? 'bg-amber-400 animate-ping' : activeItem.status === 'completed' ? 'bg-emerald-500' : 'bg-gray-400'"></span>
          <span>{{ statusLabel(activeItem.status) }}</span>
        </span>
      </div>

      <!-- 子会话消息轨迹正文 (使用与主消息列表完全一致的公共渲染组件) -->
      <div class="flex-1 overflow-hidden relative flex flex-col min-h-0 select-text">
        <ChatMessageList
          ref="subScrollLoaderRef"
          :messages="subMessages || []"
          :turnMap="turnMap"
          :sessionId="activeSubSession?.id || activeItem.id"
          :isDark="isDark"
          :isLoading="isLoadingMessages"
          loadingText="正在加载子代理会话轨迹..."
          :loadError="messagesError"
          :hasMore="hasMoreSubMessages"
          :isLoadingMore="isLoadingMoreSubMessages"
          :compact="true"
          @load="emit('loadMoreMessages')"
          @retryInitialLoad="emit('retryMessages')"
          @selectSubSession="(id) => emit('selectOption', id)"
          @scroll="handleSubListScroll"
        />
      </div>
    </div>

    <!-- 2.2 未选中具体子会话时：展示全部成员 Options 概览列表 -->
    <div v-else class="flex flex-col h-full overflow-hidden">
      <!-- 面板顶栏：协作状态与折叠操作 -->
      <div :class="['px-4 py-3 border-b flex items-center justify-between shrink-0', isDark ? 'border-white/[0.06] bg-[#0d0e12]/80' : 'border-gray-200/80 bg-white/80']">
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
            <p class="text-[11px] text-gray-400 dark:text-zinc-500 truncate">点击成员卡片展开独立执行轨迹</p>
          </div>
        </div>

        <!-- 折叠面板按钮 -->
        <button
          @click="emit('toggleOpen')"
          :class="['p-1.5 rounded-lg border transition cursor-pointer text-gray-400 hover:text-gray-200', isDark ? 'border-white/[0.08] hover:bg-white/[0.06]' : 'border-gray-200 hover:bg-gray-100']"
          title="收起侧边面板"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <!-- 滚动内容区 -->
      <div class="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
        <!-- 子 Agent Options 选项卡列表 -->
        <div
          v-for="(it, idx) in items"
          :key="it.id"
          @click="handleSelectCard(it.id)"
          :class="[
            'p-3 rounded-2xl border transition-all cursor-pointer select-none space-y-2',
            String(activeSubId) === String(it.id)
              ? (isDark ? 'border-blue-500 bg-blue-600/15 ring-1 ring-blue-500/40 shadow-sm' : 'border-blue-400 bg-blue-50/70 ring-1 ring-blue-300 shadow-sm')
              : (isDark ? 'border-white/[0.06] bg-zinc-900/60 hover:border-white/[0.12] hover:bg-zinc-800/80' : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/30')
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
  </div>
  </Transition>
</template>

<style scoped>
.sub-panel-shell {
  width: var(--sub-panel-width);
  transition: width 200ms ease-out;
}

.sub-panel-shell.is-resizing {
  transition: none;
}

.sub-panel-enter-active,
.sub-panel-leave-active {
  overflow: hidden;
  pointer-events: none;
  transition: width 320ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sub-panel-enter-active > aside,
.sub-panel-leave-active > aside {
  transition: opacity 240ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sub-panel-enter-from,
.sub-panel-leave-to {
  width: 0;
}

.sub-panel-enter-from > aside,
.sub-panel-leave-to > aside {
  opacity: 0;
  transform: translateX(20px);
}

.sub-panel-tab-enter-active,
.sub-panel-tab-leave-active {
  transition: opacity 180ms ease;
}

.sub-panel-tab-enter-from,
.sub-panel-tab-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .sub-panel-shell,
  .sub-panel-enter-active,
  .sub-panel-leave-active,
  .sub-panel-enter-active > aside,
  .sub-panel-leave-active > aside,
  .sub-panel-tab-enter-active,
  .sub-panel-tab-leave-active {
    transition: none;
  }
}
</style>
