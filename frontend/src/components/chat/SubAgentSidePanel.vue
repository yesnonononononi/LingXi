<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SubSessionVO, SubItemStatus, ToolCallTrace } from '../../types/chat';
import { formatTokens } from '../../utils/format';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import MarkdownRenderer from './MarkdownRenderer.vue';

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
  isDark?: boolean;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectOption', id: string | number | null): void;
  (e: 'toggleOpen'): void;
}>();

// 复制反馈（子会话 id 键控；见 composables/useCopyFeedback.ts）
const { copiedKey: copiedId, copy: copyRaw } = useCopyFeedback();
const expandedTaskId = ref<Record<string, boolean>>({});

const activeItem = computed(() => {
  if (props.activeSubId === null) return null;
  return props.items.find(it => String(it.id) === String(props.activeSubId)) || null;
});

// formatTokens 已收敛到 utils/format.ts
const handleCopyResult = (text: string, id: string | number) => {
  void copyRaw(text, id);
};

const toggleTaskExpand = (id: string | number) => {
  const key = String(id);
  expandedTaskId.value[key] = !expandedTaskId.value[key];
};
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
      'w-80 lg:w-84 xl:w-92 shrink-0 border-l flex flex-col h-full z-20 backdrop-blur-md transition-all duration-300 ease-in-out select-none',
      isDark ? 'bg-[#0e131c]/90 border-[#1f2838] text-gray-200' : 'bg-gray-50/80 border-gray-200 text-gray-800'
    ]"
  >
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
            <h3 class="text-xs font-semibold truncate">子代理协作 Session</h3>
            <span :class="['px-1.5 py-0.2 rounded-full text-[10px] font-mono font-medium', isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700']">
              {{ items.length }}
            </span>
          </div>
          <p class="text-[11px] text-gray-400 truncate">点击 Options 切换左侧会话历史</p>
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
    <div class="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-4">

      <!-- 1. 会话 Options 选项切换区 (主会话 + 子 Agent 列表) -->
      <div class="space-y-2">
        <div class="flex items-center justify-between text-[11px] text-gray-400 px-1 font-medium">
          <span>OPTIONS (会话切换)</span>
          <span v-if="activeSubId !== null" class="text-blue-500 font-normal cursor-pointer hover:underline" @click="emit('selectOption', null)">
            切回主会话
          </span>
        </div>

        <!-- 主会话 Option -->
        <div
          @click="emit('selectOption', null)"
          :class="[
            'p-2.5 rounded-xl border transition-all cursor-pointer select-none flex items-center justify-between gap-2',
            activeSubId === null
              ? (isDark ? 'border-blue-500/80 bg-blue-600/15 ring-1 ring-blue-500/30 text-blue-300' : 'border-blue-400 bg-blue-50 ring-1 ring-blue-300 text-blue-800')
              : (isDark ? 'border-[#222d40] bg-[#121824]/60 hover:bg-[#161e2e] text-gray-400 hover:text-gray-200' : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-900')
          ]"
        >
          <div class="flex items-center gap-2 min-w-0">
            <div :class="['w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 font-medium', activeSubId === null ? 'bg-blue-500 text-white' : (isDark ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-600')]">
              主
            </div>
            <div class="min-w-0">
              <span class="text-xs font-semibold block truncate">主会话历史</span>
              <span class="text-[10px] opacity-70 block truncate">与主指挥 Agent 的对话流</span>
            </div>
          </div>
          <span v-if="activeSubId === null" class="text-[11px] font-medium text-blue-500 shrink-0">当前展示 ✓</span>
          <span v-else class="text-[10px] opacity-50 shrink-0">点击切回</span>
        </div>

        <!-- 子 Agent Options 选项卡列表 (对齐用户截图 Image 2 样式) -->
        <div
          v-for="(it, idx) in items"
          :key="it.id"
          @click="emit('selectOption', it.id)"
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
          <div :class="['p-2 rounded-xl text-xs space-y-1', isDark ? 'bg-[#0d121a]' : 'bg-gray-50']">
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
                左侧已同步轨迹
              </span>
              <span
                v-else
                class="text-[11px] text-gray-400 hover:text-blue-500 flex items-center gap-1"
              >
                <span>点击切换左侧会话历史</span>
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

      <!-- 2. 当前选中子 Agent 详细轨迹与产出预览 -->
      <div v-if="activeItem" class="pt-2 border-t border-gray-200/70 dark:border-[#1e2738] space-y-2.5">
        <div class="flex items-center justify-between text-[11px] text-gray-400 px-1 font-medium">
          <span>当前轨迹与产出</span>
          <span class="text-blue-500 font-mono">{{ activeItem.agentName }}</span>
        </div>

        <div :class="['p-3 rounded-2xl border text-xs select-text space-y-2', isDark ? 'border-[#222d40] bg-[#111622]' : 'border-gray-200 bg-white']">
          <div class="flex items-center justify-between text-gray-400 border-b pb-1.5 dark:border-gray-800">
            <span>产出状态:</span>
            <span class="font-medium" :class="activeItem.status === 'running' ? 'text-amber-500' : (activeItem.status === 'failed' || activeItem.status === 'cancelled') ? 'text-red-500' : activeItem.status === 'suspended' ? 'text-blue-500' : (activeItem.status === 'idle' || activeItem.status === 'unknown') ? 'text-gray-400' : 'text-emerald-500'">
              {{ statusLabel(activeItem.status, true) }}
            </span>
          </div>

          <!-- 提示上下文 -->
          <div v-if="activeItem.prompt" class="text-gray-500 dark:text-gray-400 text-[11px] space-y-1">
            <div class="flex items-center justify-between">
              <span class="font-medium text-gray-400">提示上下文:</span>
              <button
                @click="toggleTaskExpand(activeItem.id)"
                class="text-[10px] text-blue-500 hover:underline cursor-pointer"
              >
                {{ expandedTaskId[String(activeItem.id)] ? '收起' : '展开' }}
              </button>
            </div>
            <p :class="['whitespace-pre-wrap', !expandedTaskId[String(activeItem.id)] ? 'line-clamp-2' : '']">
              {{ activeItem.prompt }}
            </p>
          </div>

          <!-- 产出文本预览 -->
          <div class="pt-1">
            <span class="text-[11px] font-medium text-gray-400 block mb-1">产出结果文本:</span>
            <div v-if="activeItem.status === 'running'" class="py-3 flex items-center gap-2 text-amber-500 text-xs select-none">
              <span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
              <span>子代理正在深入分析与计算中...</span>
            </div>
            <div v-else-if="activeItem.result" class="max-h-56 overflow-y-auto scrollbar-thin text-xs leading-relaxed">
              <MarkdownRenderer :content="activeItem.result" :is-dark="isDark" />
            </div>
            <div v-else class="text-[11px] text-gray-400 font-mono py-1">
              (暂无独立产出文本)
            </div>
          </div>
        </div>
      </div>

    </div>
  </aside>
</template>
