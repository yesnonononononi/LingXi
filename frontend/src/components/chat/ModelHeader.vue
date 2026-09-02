<script setup lang="ts">
import { ref } from 'vue';
import type { ModelConfig, KnowledgeBase } from '../../types/chat';

const props = defineProps<{
  models: ModelConfig[];
  knowledgeBases: KnowledgeBase[];
  selectedModelId: string | number;
  selectedKbId: string;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'updateModel', modelId: string | number): void;
  (e: 'updateKb', kbId: string): void;
  (e: 'toggleTheme'): void;
  (e: 'openSettings'): void;
}>();

const isModelDropdownOpen = ref(false);
const isKbDropdownOpen = ref(false);

const selectModel = (id: string | number) => {
  emit('updateModel', id);
  isModelDropdownOpen.value = false;
};

const selectKb = (id: string) => {
  emit('updateKb', id);
  isKbDropdownOpen.value = false;
};
</script>

<template>
  <header
    :class="[
      'h-14 px-4 flex items-center justify-between border-b shrink-0 select-none transition-colors z-20',
      isDark ? 'bg-[#0b0f17]/90 border-[#273043] text-gray-200 backdrop-blur' : 'bg-white/90 border-gray-200 text-gray-800 backdrop-blur'
    ]"
  >
    <!-- Left: Model Dropdown Picker -->
    <div class="flex items-center gap-3">
      <div class="relative">
        <button
          @click="isModelDropdownOpen = !isModelDropdownOpen"
          :class="[
            'flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-medium transition',
            isDark ? 'bg-[#161b26] border-[#2d3a54] hover:border-blue-500/50 text-gray-200' : 'bg-gray-50 border-gray-200 hover:border-blue-400 text-gray-700'
          ]"
        >
          <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
          <span>{{ models.find(m => m.id === selectedModelId)?.name || 'DeepSeek-R1' }}</span>
          <svg class="w-4 h-4 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- Model Popover -->
        <div
          v-if="isModelDropdownOpen"
          @click.self="isModelDropdownOpen = false"
          :class="[
            'absolute left-0 mt-2 w-64 rounded-2xl shadow-2xl border py-2 z-50 transition-all',
            isDark ? 'bg-[#161b26] border-[#273043] text-gray-200' : 'bg-white border-gray-200 text-gray-800'
          ]"
        >
          <div class="px-3 py-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            选择基座模型
          </div>
          <div
            v-for="model in models"
            :key="model.id"
            @click="selectModel(model.id)"
            :class="[
              'px-3 py-2.5 mx-1 rounded-xl cursor-pointer transition text-xs flex flex-col gap-0.5',
              selectedModelId === model.id
                ? (isDark ? 'bg-blue-600/20 text-blue-400 font-semibold' : 'bg-blue-50 text-blue-600 font-semibold')
                : (isDark ? 'hover:bg-[#202738] text-gray-300' : 'hover:bg-gray-100 text-gray-700')
            ]"
          >
            <div class="flex items-center justify-between">
              <span>{{ model.name }}</span>
              <span v-if="selectedModelId === model.id" class="text-blue-500 text-xs">✓</span>
            </div>
            <span class="text-[10px] opacity-60 font-normal truncate">{{ model.description }}</span>
          </div>
        </div>
      </div>

      <!-- KB Selector Dropdown -->
      <div class="relative hidden sm:block">
        <button
          @click="isKbDropdownOpen = !isKbDropdownOpen"
          :class="[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs transition',
            selectedKbId ? 'border-indigo-500/40 text-indigo-400 bg-indigo-500/10' : (isDark ? 'bg-[#161b26] border-[#2d3a54] text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600')
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <span class="truncate max-w-[120px]">{{ knowledgeBases.find(k => k.id === selectedKbId)?.name || '未关联知识库' }}</span>
        </button>

        <div
          v-if="isKbDropdownOpen"
          :class="[
            'absolute left-0 mt-2 w-56 rounded-2xl shadow-2xl border py-2 z-50',
            isDark ? 'bg-[#161b26] border-[#273043] text-gray-200' : 'bg-white border-gray-200 text-gray-800'
          ]"
        >
          <div
            @click="selectKb('')"
            :class="['px-3 py-2 mx-1 rounded-xl cursor-pointer text-xs transition', !selectedKbId ? 'text-blue-500 font-semibold' : 'text-gray-400']"
          >
            无知识库关联
          </div>
          <div
            v-for="kb in knowledgeBases"
            :key="kb.id"
            @click="selectKb(kb.id)"
            :class="[
              'px-3 py-2 mx-1 rounded-xl cursor-pointer text-xs transition flex flex-col',
              selectedKbId === kb.id ? (isDark ? 'bg-indigo-600/20 text-indigo-400' : 'bg-indigo-50 text-indigo-600') : (isDark ? 'hover:bg-[#202738]' : 'hover:bg-gray-100')
            ]"
          >
            <span class="font-medium">{{ kb.name }}</span>
            <span class="text-[10px] opacity-60">{{ kb.documentCount }} 篇相关片段</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Controls: Dark Mode Toggle & Settings -->
    <div class="flex items-center gap-2">
      <!-- Theme Switch -->
      <button
        @click="emit('toggleTheme')"
        :class="[
          'p-2 rounded-xl border transition',
          isDark ? 'bg-[#161b26] border-[#2d3a54] text-yellow-400 hover:bg-[#202738]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
        ]"
        title="切换色彩主题"
      >
        <svg v-if="isDark" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      </button>

      <!-- Open Settings -->
      <button
        @click="emit('openSettings')"
        :class="[
          'p-2 rounded-xl border transition',
          isDark ? 'bg-[#161b26] border-[#2d3a54] text-gray-300 hover:bg-[#202738]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
        ]"
        title="打开偏好设置"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </div>
  </header>
</template>
