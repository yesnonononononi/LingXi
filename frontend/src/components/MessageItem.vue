<script setup lang="ts">
import { ref } from 'vue';
import type { ChatMessage } from '../types/chat';
import ToolTrace from './ToolTrace.vue';
import CitationList from './CitationList.vue';

const props = defineProps<{
  message: ChatMessage;
  isDark: boolean;
}>();

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
};

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string, index: number): void;
  (e: 'editMessage', messageId: string, newText: string): void;
}>();

const isThoughtExpanded = ref(true);
const isEditing = ref(false);
const editText = ref(props.message.content);

const toggleThought = () => {
  isThoughtExpanded.value = !isThoughtExpanded.value;
};

const handleSwitchBranch = (dir: 'prev' | 'next') => {
  if (!props.message.branches || props.message.activeBranchIndex === undefined) return;
  const current = props.message.activeBranchIndex;
  const total = props.message.branches.length;
  
  let target = current;
  if (dir === 'prev' && current > 0) target = current - 1;
  if (dir === 'next' && current < total - 1) target = current + 1;
  
  if (target !== current) {
    emit('switchBranch', props.message.id, target);
  }
};

const startEdit = () => {
  editText.value = props.message.content;
  isEditing.value = true;
};

const saveEdit = () => {
  if (editText.value.trim() && editText.value !== props.message.content) {
    emit('editMessage', props.message.id, editText.value);
  }
  isEditing.value = false;
};

// 辅助：提取代码块
const formatMessageContent = (text: string) => {
  // 对段落与代码块进行基本渲染（避免引入第三方繁重的 markdown 库）
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    if (part.startsWith('```')) {
      const match = part.match(/```(\w*)\n([\s\S]*?)```/);
      const lang = match ? match[1] : '';
      const code = match ? match[2] : part.slice(3, -3);
      return { type: 'code', lang, content: code.trim() };
    }
    return { type: 'text', content: part };
  });
};
</script>

<template>
  <div 
    class="flex space-x-4 p-4 border-b transition-colors duration-200"
    :class="[
      isDark ? 'border-gray-900/50' : 'border-slate-200/60',
      message.role === 'user' 
        ? (isDark ? 'bg-gray-950/20' : 'bg-slate-100/40') 
        : (isDark ? 'bg-gray-900/10' : 'bg-white')
    ]"
  >
    <!-- Avatar -->
    <div class="flex-shrink-0">
      <div 
        v-if="message.role === 'user'"
        class="w-8 h-8 rounded-md flex items-center justify-center text-sm font-semibold border transition-colors"
        :class="isDark ? 'bg-gray-800 border-gray-700 text-gray-300' : 'bg-slate-200 border-slate-300 text-slate-600'"
      >
        U
      </div>
      <div 
        v-else
        class="w-8 h-8 rounded-md flex items-center justify-center border shadow-sm transition-all"
        :class="isDark ? 'bg-slate-850 border-slate-750 text-slate-300' : 'bg-slate-700 border-slate-650 text-white'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
        </svg>
      </div>
    </div>

    <!-- Content Body -->
    <div class="flex-grow space-y-3 min-w-0">
      <!-- Header Info -->
      <div class="flex items-center justify-between text-xs" :class="isDark ? 'text-gray-500' : 'text-slate-400'">
        <div class="flex items-center space-x-2">
          <span class="font-bold" :class="isDark ? 'text-gray-300' : 'text-slate-800'">
            {{ message.role === 'user' ? '用户' : 'DevSquad Agent' }}
          </span>
          <span v-if="message.model" class="px-1.5 py-0.5 rounded border scale-95 transition-colors" :class="isDark ? 'border-gray-800 bg-gray-900/60 text-gray-400' : 'border-slate-200 bg-slate-50 text-slate-500'">
            {{ message.model }}
          </span>
        </div>
        
        <!-- Multi-Branch controls (user only) -->
        <div 
          v-if="message.role === 'user' && message.branches && message.branches.length > 1"
          class="flex items-center space-x-1.5 px-2 py-0.5 rounded border scale-90 transition-colors"
          :class="isDark ? 'bg-gray-900/50 border-gray-800/80 text-gray-400' : 'bg-white border-slate-200 text-slate-500 shadow-sm'"
        >
          <button 
            @click="handleSwitchBranch('prev')" 
            :disabled="message.activeBranchIndex === 0"
            class="hover:text-indigo-500 disabled:opacity-30 disabled:hover:text-gray-500"
          >
            &lt;
          </button>
          <span class="font-mono">{{ (message.activeBranchIndex || 0) + 1 }} / {{ message.branches.length }}</span>
          <button 
            @click="handleSwitchBranch('next')" 
            :disabled="message.activeBranchIndex === message.branches.length - 1"
            class="hover:text-indigo-500 disabled:opacity-30 disabled:hover:text-gray-500"
          >
            &gt;
          </button>
        </div>
      </div>

      <!-- Thinking Indicator (CoT 思维链展开面板) -->
      <div 
        v-if="message.role === 'assistant' && (message.isThinking || (message.thoughtSteps && message.thoughtSteps.length > 0))" 
        class="border-l-2 pl-3 space-y-2 py-0.5"
        :class="isDark ? 'border-gray-800' : 'border-slate-200'"
      >
        <button 
          @click="toggleThought"
          class="flex items-center space-x-1.5 text-xs transition-colors cursor-pointer"
          :class="isDark ? 'text-gray-400 hover:text-white' : 'text-slate-400 hover:text-slate-600'"
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            viewBox="0 0 20 20" 
            fill="currentColor" 
            class="w-3.5 h-3.5 transition-transform duration-200"
            :class="{ 'rotate-90': isThoughtExpanded }"
          >
            <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
          </svg>
          <span class="font-semibold">
            {{ message.isThinking ? '思考中...' : '已完成推理路径 (思维链)' }}
          </span>
          <span 
            v-if="message.isThinking" 
            class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"
          ></span>
        </button>

        <!-- CoT Detail Steps -->
        <div 
          v-show="isThoughtExpanded" 
          class="space-y-1.5 text-xs font-mono mt-1"
          :class="isDark ? 'text-gray-500' : 'text-slate-400'"
        >
          <div 
            v-for="step in message.thoughtSteps" 
            :key="step.id"
            class="flex items-start space-x-2"
          >
            <span class="text-blue-500 font-bold">↳</span>
            <div class="flex-grow">
              <div class="flex justify-between items-center" :class="isDark ? 'text-gray-400' : 'text-slate-650'">
                <span class="font-bold">{{ step.title }}</span>
                <span v-if="step.durationMs" class="text-[10px] text-gray-600">{{ step.durationMs }}ms</span>
              </div>
              <p class="mt-0.5 leading-relaxed" :class="isDark ? 'text-gray-500' : 'text-slate-450'">{{ step.content }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Main Message Text (Normal / Code Rendering) -->
      <div 
        class="text-sm leading-relaxed font-sans transition-colors duration-200" 
        :class="isDark ? 'text-gray-200' : 'text-slate-700'"
      >
        <!-- Editing State -->
        <div v-if="isEditing" class="space-y-2">
          <textarea 
            v-model="editText" 
            class="w-full rounded-md p-2 text-sm focus:outline-none" 
            :class="isDark ? 'bg-gray-950 border border-gray-800 text-gray-200 focus:border-blue-700' : 'bg-white border border-slate-205 text-slate-800 focus:border-indigo-500'"
            rows="3"
          ></textarea>
          <div class="flex space-x-2 justify-end">
            <button @click="isEditing = false" class="px-2.5 py-1 text-xs rounded border text-gray-400 hover:text-white" :class="isDark ? 'border-gray-800' : 'border-slate-200 hover:bg-slate-50'">
              取消
            </button>
            <button @click="saveEdit" class="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500">
              确认修改
            </button>
          </div>
        </div>

        <!-- Render Content -->
        <div v-else class="space-y-3">
          <div 
            v-for="(part, idx) in formatMessageContent(message.content)" 
            :key="idx"
          >
            <!-- Code Chunk -->
            <div v-if="part.type === 'code'" class="my-2 border rounded-md overflow-hidden font-mono text-xs" :class="isDark ? 'border-gray-800/80' : 'border-slate-200'">
              <div class="px-3 py-1 text-[10px] border-b flex justify-between items-center" :class="isDark ? 'bg-gray-950 text-gray-500 border-gray-900' : 'bg-slate-100 text-slate-550 border-slate-200'">
                <span>{{ part.lang || 'code' }}</span>
                <span class="cursor-pointer hover:text-indigo-650" @click="copyToClipboard(part.content || '')">复制</span>
              </div>
              <pre class="p-3 overflow-x-auto" :class="isDark ? 'bg-black/60 text-gray-300' : 'bg-slate-50 text-slate-800'">{{ part.content }}</pre>
            </div>
            
            <!-- Standard Paragraph -->
            <p v-else class="whitespace-pre-wrap select-text">{{ part.content }}</p>
          </div>
        </div>
      </div>

      <!-- Edit message icon for User -->
      <div 
        v-if="message.role === 'user' && !isEditing" 
        class="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <button 
          @click="startEdit" 
          class="text-xs text-gray-500 hover:text-gray-300 flex items-center space-x-1 cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
          </svg>
          <span>编辑</span>
        </button>
      </div>

      <!-- Tool Trace Panel -->
      <ToolTrace 
        v-if="message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0"
        :traces="message.toolCalls"
        :isDark="isDark"
      />

      <!-- Citations Panel -->
      <CitationList 
        v-if="message.role === 'assistant' && message.citations && message.citations.length > 0"
        :citations="message.citations"
        :isDark="isDark"
      />
    </div>
  </div>
</template>
