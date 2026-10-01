<script setup lang="ts">
import type { SubSessionVO } from '../../types/chat';
import { formatClockTime } from '../../utils/format';

const props = defineProps<{
  isOpen: boolean;
  subSessions: SubSessionVO[];
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'selectSubSession', sub: SubSessionVO): void;
}>();

</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
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
          'fixed inset-y-0 right-0 w-full max-w-xl shadow-2xl z-50 flex flex-col border-l transition-colors',
          isDark ? 'bg-[#0f141c] border-[#222b3d] text-gray-100' : 'bg-white border-gray-200 text-gray-800'
        ]"
      >
        <!-- 头部 -->
        <div :class="['px-6 py-4 border-b flex items-center justify-between shrink-0', isDark ? 'border-[#222b3d] bg-[#141a24]' : 'border-gray-100 bg-gray-50/70']">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-400 flex items-center justify-center text-white shadow-sm shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="font-semibold text-sm">子代理协作会话列表</h3>
                <span :class="['text-[11px] px-2 py-0.5 rounded-full font-mono font-medium', isDark ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20' : 'bg-blue-50 text-blue-600 border border-blue-200']">
                  共 {{ subSessions.length }} 个子会话
                </span>
              </div>
              <p class="text-xs text-gray-400 mt-0.5">
                当前主会话在团队协同中派生并持久化的全部专业代理 Session
              </p>
            </div>
          </div>

          <button
            @click="emit('close')"
            :class="['p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-500/10 transition cursor-pointer']"
            title="关闭概览"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- 查看提示 -->
        <div :class="['px-6 py-2.5 border-b text-xs flex items-center justify-between gap-4 select-none', isDark ? 'border-[#222b3d] bg-[#121721] text-gray-400' : 'border-gray-100 bg-gray-50/40 text-gray-500']">

          <span class="text-[11px] opacity-70">点击卡片即可调出该代理的独立执行轨迹</span>
        </div>

        <!-- 子会话列表 -->
        <div class="flex-1 overflow-y-auto p-6 space-y-3.5 scrollbar-thin">
          <div
            v-if="subSessions.length === 0"
            class="py-16 text-center text-gray-400 text-xs flex flex-col items-center justify-center gap-2"
          >
            <svg class="w-10 h-10 text-gray-500/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span>当前会话暂无委派产生的子代理 Session</span>
          </div>

          <div
            v-for="(sub, idx) in subSessions"
            :key="sub.id"
            @click="emit('selectSubSession', sub)"
            :class="[
              'p-4 rounded-2xl border transition-all cursor-pointer group shadow-2xs hover:shadow-sm select-none',
              isDark
                ? 'border-[#222c3d] bg-[#131924] hover:border-blue-500/50 hover:bg-[#162030]'
                : 'border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50/30'
            ]"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center text-white text-xs font-semibold shadow-xs shrink-0">
                  {{ idx + 1 }}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h4 class="font-semibold text-sm truncate group-hover:text-blue-500 transition-colors">
                      {{ sub.agentName || (sub.agentId ? `Agent #${sub.agentId}` : '子代理') }}
                    </h4>
                    <span :class="['text-[10px] px-1.5 py-0.2 rounded-full font-mono', isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600']">
                      #{{ sub.id }}
                    </span>
                  </div>
                  <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">
                    {{ sub.name || sub.task || '执行委派计算与处理任务' }}
                  </p>
                </div>
              </div>

              <!-- 右侧状态与查看按钮 -->
              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  class="p-1 rounded-lg text-blue-500 group-hover:bg-blue-500/10 transition"
                  title="查看详情"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            <div class="mt-3 pt-2.5 border-t border-gray-500/15 flex items-center justify-between text-[11px] text-gray-400">
              <span>
                {{ sub.messageCount ? `${sub.messageCount} 条会话消息` : '已归档' }}
              </span>
              <span v-if="sub.createTime" class="font-mono">
                {{ formatClockTime(sub.createTime) }}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>
