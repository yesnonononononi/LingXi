<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage } from '../../types/chat';

const props = defineProps<{
  message: ChatMessage;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string, index: number): void;
  (e: 'editMessage', messageId: string, newText: string): void;
}>();

const isThoughtExpanded = ref(true);
const isEditing = ref(false);
const editText = ref(props.message.content);
const copied = ref(false);

const activeBranchIdx = computed(() => props.message.activeBranchIndex ?? 0);
const totalBranches = computed(() => props.message.branches?.length ?? 1);

const calculatedThoughtDuration = computed(() => {
  if (!props.message.thoughtSteps?.length) return 0;
  return props.message.thoughtSteps.reduce((acc, step) => acc + (step.durationMs || 0), 0);
});

const copyContent = async () => {
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    console.error('复制失败:', e);
  }
};

const handleSaveEdit = () => {
  if (editText.value.trim() && editText.value !== props.message.content) {
    emit('editMessage', props.message.id, editText.value.trim());
  }
  isEditing.value = false;
};
</script>

<template>
  <div :class="['w-full py-4 px-2 sm:px-4 transition-colors', props.message.role === 'user' ? 'flex justify-end' : 'flex justify-start']">
    <div :class="['max-w-3xl w-full flex gap-3', props.message.role === 'user' ? 'flex-row-reverse' : 'flex-row']">
      
      <!-- Avatar -->
      <div
        :class="[
          'w-8 h-8 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 shadow-sm',
          props.message.role === 'user'
            ? 'bg-gradient-to-tr from-blue-600 to-indigo-600 text-white'
            : 'bg-gradient-to-tr from-[#4d6bfe] to-purple-600 text-white'
        ]"
      >
        {{ props.message.role === 'user' ? '你' : 'DeepSeek' }}
      </div>

      <!-- Main Message Body -->
      <div class="flex-1 overflow-hidden space-y-2.5">
        <!-- Message Meta / Model Name -->
        <div class="flex items-center gap-2 text-xs opacity-60">
          <span class="font-semibold">{{ props.message.role === 'user' ? '发送的消息' : (props.message.model || 'DeepSeek-R1') }}</span>
          <span>·</span>
          <span>{{ new Date(props.message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
        </div>

        <!-- User Message Card -->
        <div v-if="props.message.role === 'user'" class="group relative">
          <div v-if="!isEditing" :class="['p-3.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm', isDark ? 'bg-[#1e2638] text-gray-100 border border-[#2d3a54]' : 'bg-blue-600 text-white']">
            {{ props.message.content }}
          </div>
          <!-- Edit Input for User Message -->
          <div v-else class="space-y-2">
            <textarea
              v-model="editText"
              rows="3"
              :class="['w-full p-3 rounded-xl text-sm border outline-none resize-none', isDark ? 'bg-[#161b26] border-[#273043] text-white' : 'bg-white border-gray-300 text-gray-900']"
            ></textarea>
            <div class="flex justify-end gap-2 text-xs">
              <button @click="isEditing = false" class="px-3 py-1.5 rounded-lg border hover:bg-gray-500/10">取消</button>
              <button @click="handleSaveEdit" class="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 font-medium">发送并更新</button>
            </div>
          </div>

          <!-- Edit trigger button -->
          <button v-if="!isEditing" @click="isEditing = true" class="absolute -left-8 top-2 opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-400 transition" title="编辑消息">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        </div>

        <!-- Assistant Message Card -->
        <div v-else class="space-y-3">
          
          <!-- 1. DeepThink 思考过程折叠卡片 (CoT Chain) -->
          <div v-if="props.message.thoughtSteps?.length" :class="['rounded-2xl border overflow-hidden transition-all', isDark ? 'border-[#273043] bg-[#161b26]/70' : 'border-gray-200 bg-gray-50/80']">
            <!-- Header Toggle -->
            <button
              @click="isThoughtExpanded = !isThoughtExpanded"
              class="w-full px-3.5 py-2.5 flex items-center justify-between text-xs text-gray-400 hover:text-gray-200 transition select-none"
            >
              <div class="flex items-center gap-2 font-medium">
                <span class="text-sm">🧠</span>
                <span v-if="props.message.isThinking" class="text-blue-400 animate-pulse">深度思考中...</span>
                <span v-else class="text-gray-400">已深度思考 (用时 {{ (calculatedThoughtDuration / 1000).toFixed(1) }} 秒)</span>
              </div>
              <svg :class="['w-4 h-4 transition-transform duration-200', isThoughtExpanded ? 'rotate-180' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <!-- Expanded Steps Content -->
            <div v-if="isThoughtExpanded" class="px-4 pb-3.5 pt-1 space-y-2 border-t border-dashed border-gray-500/20 text-xs deepthink-striped-bg">
              <div
                v-for="step in props.message.thoughtSteps"
                :key="step.id"
                class="pl-3 border-l-2 border-blue-500/50 space-y-0.5"
              >
                <div class="flex items-center gap-2 font-semibold text-gray-300">
                  <span>{{ step.title }}</span>
                  <span v-if="step.durationMs" class="text-[10px] text-gray-500 font-normal">({{ step.durationMs }}ms)</span>
                </div>
                <div class="text-gray-400 opacity-90 leading-relaxed font-mono text-[11px]">{{ step.content }}</div>
              </div>
            </div>
          </div>

          <!-- 2. RAG Citations 知识库/检索引用卡片 -->
          <div v-if="props.message.citations?.length" class="flex flex-wrap gap-2 text-[11px]">
            <div
              v-for="cit in props.message.citations"
              :key="cit.id"
              :class="['px-2.5 py-1 rounded-lg border flex items-center gap-1.5', isDark ? 'bg-[#1a202c] border-[#2d3a54] text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700']"
            >
              <span>📄</span>
              <span class="font-medium truncate max-w-[150px]">{{ cit.sourceName }}</span>
              <span class="opacity-60 text-[10px]">(匹配度 {{ (cit.score * 100).toFixed(0) }}%)</span>
            </div>
          </div>

          <!-- 3. Assistant Output Text Body -->
          <div :class="['text-sm leading-relaxed space-y-2 font-normal', isDark ? 'text-gray-200' : 'text-gray-800', props.message.isThinking ? 'typing-cursor' : '']">
            <div class="whitespace-pre-wrap">{{ props.message.content }}</div>
          </div>

          <!-- 4. Assistant Action Footer (Copy, Branch Switcher) -->
          <div v-if="!props.message.isThinking && props.message.content" class="flex items-center justify-between pt-1 text-xs opacity-70">
            <!-- Branch Switcher (< 1/3 >) -->
            <div v-if="totalBranches > 1" class="flex items-center gap-1 bg-gray-500/10 px-2 py-0.5 rounded-lg">
              <button
                :disabled="activeBranchIdx === 0"
                @click="emit('switchBranch', props.message.id, activeBranchIdx - 1)"
                class="disabled:opacity-30 hover:text-blue-400"
              >&lt;</button>
              <span>{{ activeBranchIdx + 1 }} / {{ totalBranches }}</span>
              <button
                :disabled="activeBranchIdx === totalBranches - 1"
                @click="emit('switchBranch', props.message.id, activeBranchIdx + 1)"
                class="disabled:opacity-30 hover:text-blue-400"
              >&gt;</button>
            </div>
            <div v-else></div>

            <!-- Actions: Copy & Feedback -->
            <div class="flex items-center gap-2">
              <button @click="copyContent" class="flex items-center gap-1 hover:text-blue-400 transition" title="复制回答">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span>{{ copied ? '已复制' : '复制' }}</span>
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  </div>
</template>
