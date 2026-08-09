<script setup lang="ts">
import { ref } from 'vue';
import type { RAGCitation } from '../types/chat';

defineProps<{
  citations: RAGCitation[];
  isDark: boolean;
}>();

const activeCitationId = ref<string | null>(null);

const toggleCitation = (id: string) => {
  activeCitationId.value = activeCitationId.value === id ? null : id;
};
</script>

<template>
  <div class="mt-3 pt-3 border-t transition-colors duration-200" :class="isDark ? 'border-gray-800/60' : 'border-slate-200/60'">
    <div class="flex items-center space-x-1.5 mb-2 text-xs font-semibold" :class="isDark ? 'text-gray-400' : 'text-slate-500'">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5 text-blue-500">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18V6a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 6v3.75m-9.75 0h.008v.008H12V9.75z" />
      </svg>
      <span>混合检索与重排召回源 (RAG Citations)</span>
    </div>

    <!-- Citations Row -->
    <div class="flex flex-wrap gap-2">
      <div 
        v-for="cite in citations" 
        :key="cite.id"
        class="relative"
      >
        <button
          @click="toggleCitation(cite.id)"
          class="text-xs flex items-center space-x-1.5 px-2.5 py-1.5 rounded-md border text-left transition-all duration-200 cursor-pointer"
          :class="activeCitationId === cite.id 
            ? (isDark ? 'bg-blue-950/40 border-blue-700/80 text-blue-300' : 'bg-blue-50 border-blue-300 text-blue-700 font-bold') 
            : (isDark ? 'bg-gray-900/60 border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white' : 'bg-white border-slate-200 hover:border-slate-350 text-slate-650 hover:text-slate-900 shadow-sm')"
        >
          <span class="font-bold text-[10px] px-1 rounded transition-colors" :class="isDark ? 'bg-gray-800 text-gray-400' : 'bg-slate-100 text-slate-500'">#{{ cite.chunkIndex }}</span>
          <span class="truncate max-w-[150px]">{{ cite.sourceName }}</span>
          <span 
            class="text-[10px] font-mono px-1 rounded"
            :class="cite.score >= 0.9 ? 'text-emerald-400 bg-emerald-950/20' : 'text-blue-500 bg-blue-950/20'"
          >
            {{ (cite.score * 100).toFixed(0) }}% 相似度
          </span>
        </button>
      </div>
    </div>

    <!-- Active Citation Chunk Details -->
    <div 
      v-if="activeCitationId"
      class="mt-2 text-xs border p-3 rounded-md animate-fadeIn transition-colors duration-200"
      :class="isDark 
        ? 'bg-gray-950/60 border-gray-800/80' 
        : 'bg-slate-100/40 border-slate-250 shadow-inner'"
    >
      <div 
        v-for="cite in citations.filter(c => c.id === activeCitationId)" 
        :key="cite.id"
        class="space-y-1.5"
      >
        <div class="flex justify-between items-center font-bold text-[10px]" :class="isDark ? 'text-gray-500' : 'text-slate-400'">
          <span>源文件切片第 {{ cite.chunkIndex }} 段</span>
          <span class="font-mono">Rerank Score: {{ cite.score }}</span>
        </div>
        <p class="leading-relaxed font-sans text-[11px] whitespace-pre-wrap select-text transition-colors" :class="isDark ? 'text-gray-300' : 'text-slate-650'">
          {{ cite.content }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-fadeIn {
  animation: fadeIn 0.15s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
