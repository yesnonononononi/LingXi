<script setup lang="ts">
const props = defineProps<{
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectPrompt', text: string): void;
}>();

const suggestions = [
  {
    icon: '🧠',
    title: '深度逻辑与 CoT 推理',
    desc: '请详细解析 DeepSeek-R1 的强化学习算法原理与长思维链演化机制。'
  },
  {
    icon: '💻',
    title: '代码重构与性能优化',
    desc: '帮我设计一个基于 Vue3 + TypeScript 的 Agent 流式响应打字机组件。'
  },
  {
    icon: '📊',
    title: '深度财报与数据分析',
    desc: '结合 2026 科技行业趋势，分析人工智能 Agent 商业化落地的壁垒。'
  },
  {
    icon: '🌐',
    title: '联网检索与知识库解析',
    desc: '检索关于大型语言模型 Tool Calling 与 RAG 混合召回的最新研究成果。'
  }
];
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center p-6 text-center max-w-3xl mx-auto select-none">
    <!-- Icon & Welcome Header -->
    <div class="mb-8 flex flex-col items-center">
      <div class="w-16 h-16 rounded-2xl bg-gradient-to-tr from-[#4d6bfe] via-indigo-500 to-purple-600 flex items-center justify-center shadow-xl shadow-blue-500/20 mb-4 animate-bounce-slow">
        <span class="text-white text-3xl font-extrabold tracking-widest">灵</span>
      </div>
      <h1 class="text-2xl sm:text-3xl font-bold tracking-tight mb-2 bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
        我是 灵犀 Agent，很高兴见到你。
      </h1>
      <p :class="['text-xs sm:text-sm max-w-md', isDark ? 'text-gray-400' : 'text-gray-500']">
        基于深度强化学习思维链与 RAG 向量检索架构，随时为您解答疑问、编写代码或分析数据。
      </p>
    </div>

    <!-- Suggestion Cards Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5 w-full text-left">
      <div
        v-for="(item, idx) in suggestions"
        :key="idx"
        @click="emit('selectPrompt', item.desc)"
        :class="[
          'group p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between hover:-translate-y-0.5 hover:shadow-lg',
          isDark 
            ? 'bg-[#161b26] border-[#273043] hover:border-blue-500/50 hover:bg-[#1e2638]' 
            : 'bg-white border-gray-200 hover:border-blue-400 hover:bg-blue-50/40'
        ]"
      >
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-lg">{{ item.icon }}</span>
          <span class="text-xs font-semibold text-blue-400 group-hover:text-blue-500 transition">{{ item.title }}</span>
        </div>
        <p :class="['text-xs leading-relaxed line-clamp-2', isDark ? 'text-gray-300' : 'text-gray-600']">
          {{ item.desc }}
        </p>
      </div>
    </div>
  </div>
</template>
