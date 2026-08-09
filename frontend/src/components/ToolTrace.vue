<script setup lang="ts">
import { ref } from 'vue';
import type { ToolCallTrace } from '../types/chat';

defineProps<{
  traces: ToolCallTrace[];
  isDark: boolean;
}>();

const expandedId = ref<string | null>(null);

const toggleExpand = (id: string) => {
  expandedId.value = expandedId.value === id ? null : id;
};
</script>

<template>
  <div class="space-y-2 my-2 font-mono text-xs">
    <div 
      class="text-[10px] uppercase tracking-wider font-semibold"
      :class="isDark ? 'text-gray-400' : 'text-slate-400'"
    >
      Agent 工具执行轨迹 (Tool Calling Logs)
    </div>
    
    <div 
      v-for="trace in traces" 
      :key="trace.id"
      class="border rounded-md overflow-hidden transition-all duration-200"
      :class="isDark 
        ? 'border-gray-800 bg-gray-950/70' 
        : 'border-slate-200 bg-slate-50 shadow-sm'"
    >
      <!-- Header -->
      <div 
        @click="toggleExpand(trace.id)"
        class="flex items-center justify-between px-3 py-2 cursor-pointer select-none transition-colors"
        :class="isDark ? 'hover:bg-gray-900/50' : 'hover:bg-slate-200/50'"
      >
        <div class="flex items-center space-x-2">
          <!-- Status Bullet -->
          <span class="relative flex h-2 w-2">
            <span 
              v-if="trace.status === 'calling'"
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"
            ></span>
            <span 
              class="relative inline-flex rounded-full h-2 w-2"
              :class="{
                'bg-blue-400': trace.status === 'calling',
                'bg-emerald-500': trace.status === 'success',
                'bg-rose-500': trace.status === 'failed'
              }"
            ></span>
          </span>
          
          <span class="font-bold" :class="isDark ? 'text-gray-300' : 'text-slate-700'">{{ trace.toolName }}</span>
          
          <span 
            class="text-[10px] px-1.5 py-0.5 rounded border"
            :class="{
              'bg-blue-950/30 text-blue-400 border-blue-900/50': trace.status === 'calling',
              'bg-emerald-950/30 text-emerald-400 border-emerald-900/50': trace.status === 'success',
              'bg-rose-950/30 text-rose-400 border-rose-900/50': trace.status === 'failed'
            }"
          >
            {{ trace.status === 'calling' ? 'Calling' : trace.status === 'success' ? 'Success' : 'Failed' }}
          </span>
        </div>
        
        <div class="text-gray-500 flex items-center space-x-1">
          <span>{{ expandedId === trace.id ? '收起' : '展开日志' }}</span>
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            viewBox="0 0 20 20" 
            fill="currentColor" 
            class="w-4 h-4 transition-transform duration-200"
            :class="{ 'rotate-180': expandedId === trace.id }"
          >
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </div>
      </div>
      
      <!-- Details Panel -->
      <div 
        v-show="expandedId === trace.id" 
        class="border-t p-3 space-y-2 transition-colors duration-200"
        :class="isDark ? 'border-gray-900 bg-black/40 text-gray-400' : 'border-slate-200 bg-white text-slate-650'"
      >
        <div v-if="trace.query">
          <div class="text-[10px] font-bold mb-0.5" :class="isDark ? 'text-gray-500' : 'text-slate-400'">INPUT (入参):</div>
          <pre class="p-2 rounded-md border overflow-x-auto whitespace-pre-wrap text-[11px]" :class="isDark ? 'bg-gray-950 border-gray-900 text-gray-300' : 'bg-slate-50 border-slate-200 text-slate-700'">{{ trace.query }}</pre>
        </div>
        <div v-if="trace.result">
          <div class="text-[10px] font-bold mb-0.5" :class="isDark ? 'text-gray-500' : 'text-slate-400'">OUTPUT (回执):</div>
          <pre class="p-2 rounded-md border overflow-x-auto whitespace-pre-wrap text-[11px]" :class="isDark ? 'bg-gray-950 border-gray-900 text-gray-300' : 'bg-slate-50 border-slate-200 text-slate-700'">{{ trace.result }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
