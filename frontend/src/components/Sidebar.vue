<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatSession, ModelConfig, KnowledgeBase } from '../types/chat';

const props = defineProps<{
  sessions: ChatSession[];
  activeSessionId: string | null;
  models: ModelConfig[];
  knowledgeBases: KnowledgeBase[];
  selectedModelId: string;
  selectedKbId: string;
  enabledTools: string[];
  isDark: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectSession', id: string): void;
  (e: 'newSession'): void;
  (e: 'deleteSession', id: string): void;
  (e: 'updateModel', modelId: string): void;
  (e: 'updateKb', kbId: string): void;
  (e: 'updateTools', tools: string[]): void;
  (e: 'logout'): void;
  (e: 'openSettings'): void;
}>();

const isConfigOpen = ref(false);
const isMenuOpen = ref(false);
const toastMessage = ref('');

const showActionToast = (msg: string) => {
  toastMessage.value = `已触发: ${msg}`;
  setTimeout(() => {
    toastMessage.value = '';
  }, 2000);
};

const toggleConfig = () => {
  isConfigOpen.value = !isConfigOpen.value;
};

// 按时间对会话进行分组
const groupedSessions = computed(() => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 3600000 * 24;
  const sevenDaysAgo = today - 3600000 * 24 * 7;

  const groups: { [key: string]: ChatSession[] } = {
    '今天': [],
    '昨天': [],
    '最近7天': [],
    '更早': []
  };

  props.sessions.forEach(session => {
    const time = session.updatedAt;
    if (time >= today) {
      groups['今天'].push(session);
    } else if (time >= yesterday) {
      groups['昨天'].push(session);
    } else if (time >= sevenDaysAgo) {
      groups['最近7天'].push(session);
    } else {
      groups['更早'].push(session);
    }
  });

  // 过滤掉空的分组
  return Object.keys(groups).reduce((acc, key) => {
    if (groups[key].length > 0) {
      acc[key] = groups[key];
    }
    return acc;
  }, {} as { [key: string]: ChatSession[] });
});

const handleToolToggle = (toolId: string) => {
  const updated = [...props.enabledTools];
  const idx = updated.indexOf(toolId);
  if (idx === -1) {
    updated.push(toolId);
  } else {
    updated.splice(idx, 1);
  }
  emit('updateTools', updated);
};
</script>

<template>
  <div 
    class="w-64 border-r flex flex-col h-full font-sans transition-all duration-200"
    :class="isDark 
      ? 'bg-black border-slate-900 text-slate-300' 
      : 'bg-white border-slate-200 text-slate-700'"
  >
    <!-- Header Logo -->
    <div 
      class="p-4 border-b flex items-center justify-between transition-colors duration-200"
      :class="isDark ? 'border-gray-900' : 'border-slate-200'"
    >
      <div class="flex items-center space-x-2">
        <div class="w-7 h-7 rounded flex items-center justify-center font-bold text-white text-sm bg-slate-800 border border-slate-700 shadow">
          D
        </div>
        <span 
          class="font-extrabold text-sm tracking-wider font-mono transition-colors duration-200"
          :class="isDark ? 'text-slate-100' : 'text-slate-800'"
        >
          DevSquad Hub
        </span>
      </div>
    </div>

    <!-- Actions -->
    <div class="p-3">
      <button 
        @click="emit('newSession')"
        class="w-full py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center space-x-2 transition-all active:scale-[0.98] cursor-pointer"
        :class="isDark 
          ? 'bg-slate-900 border border-slate-800 text-slate-200 hover:bg-slate-800' 
          : 'bg-slate-900 hover:bg-slate-850 text-white shadow-sm'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        <span>开启新对话</span>
      </button>
    </div>

    <!-- Sessions History List -->
    <div class="flex-grow overflow-y-auto px-2 space-y-4 scrollbar-thin">
      <div 
        v-for="(list, groupName) in groupedSessions" 
        :key="groupName"
        class="space-y-1"
      >
        <div 
          class="px-2 text-[10px] font-bold uppercase tracking-wider transition-colors duration-200"
          :class="isDark ? 'text-gray-600' : 'text-slate-400'"
        >
          {{ groupName }}
        </div>
        
        <div 
          v-for="session in list" 
          :key="session.id"
          class="group relative flex items-center justify-between rounded-md p-2 cursor-pointer transition-all duration-200 border"
          :class="activeSessionId === session.id 
            ? (isDark ? 'bg-gray-900 text-white border-gray-800' : 'bg-white text-indigo-600 border-slate-200 shadow-sm font-bold') 
            : (isDark ? 'hover:bg-gray-900/40 text-gray-400 hover:text-gray-200 border-transparent' : 'hover:bg-slate-200/50 text-slate-600 hover:text-slate-900 border-transparent')"
          @click="emit('selectSession', session.id)"
        >
          <!-- Title -->
          <div class="flex flex-col min-w-0 pr-6">
            <span class="text-xs truncate font-medium">{{ session.title }}</span>
            <div class="flex items-center space-x-1.5 mt-0.5">
              <span 
                class="text-[9px] scale-95 font-mono"
                :class="isDark ? 'text-gray-500' : 'text-slate-400'"
              >
                {{ models.find(m => m.id === session.modelId)?.name.split(' ')[0] || '开发专家' }}
              </span>
              <span v-if="session.knowledgeBaseId" class="text-[9px] text-indigo-500 scale-95 font-semibold">
                ● RAG
              </span>
            </div>
          </div>

          <!-- Delete Action -->
          <button 
            @click.stop="emit('deleteSession', session.id)"
            class="absolute right-2 opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 transition-all rounded"
            :class="isDark ? 'text-gray-600 hover:bg-gray-800' : 'text-slate-400 hover:bg-slate-200'"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-1.816A2.25 2.25 0 0115.172 3H8.828a2.25 2.25 0 00-2.228 2.368v1.816m7.5 0a41.197 41.197 0 01-7.5 0" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Footer Controls -->
    <div 
      class="p-3 border-t space-y-2 transition-colors duration-200"
      :class="isDark ? 'border-gray-900 bg-gray-950/80' : 'border-slate-200 bg-slate-100'"
    >
      <!-- Config Switcher Button -->
      <button 
        @click="toggleConfig"
        class="w-full py-1.5 px-3 rounded-md text-xs font-semibold flex items-center justify-between transition-all"
        :class="isDark 
          ? 'bg-gray-900 border border-gray-800 hover:border-gray-700 text-gray-300' 
          : 'bg-white border border-slate-200 hover:border-slate-300 text-slate-700 shadow-sm'"
      >
        <span class="flex items-center space-x-1.5">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5 text-slate-400">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.828c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827a1.125 1.125 0 01.26 1.43l-1.297 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>指派 Agent 专家组</span>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 transition-transform duration-200" :class="{ 'rotate-180': isConfigOpen }">
          <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
        </svg>
      </button>

      <!-- Advanced Config Box -->
      <div 
        v-show="isConfigOpen"
        class="rounded-md p-3 space-y-3 text-xs border transition-colors duration-200"
        :class="isDark 
          ? 'border-gray-800 bg-gray-900/60 text-gray-300' 
          : 'border-slate-200 bg-white text-slate-700 shadow-md'"
      >
        <!-- Model Selection -->
        <div>
          <label class="block text-[10px] text-gray-500 font-bold mb-1 uppercase">调度主要协作 Agent</label>
          <select 
            :value="selectedModelId"
            @change="emit('updateModel', ($event.target as HTMLSelectElement).value)"
            class="w-full border rounded p-1.5 text-xs focus:outline-none transition-colors"
            :class="isDark ? 'bg-gray-950 border-gray-800 text-gray-300' : 'bg-slate-50 border-slate-200 text-slate-700'"
          >
            <option v-for="model in models" :key="model.id" :value="model.id">
              {{ model.name }}
            </option>
          </select>
        </div>

        <!-- RAG Selection -->
        <div>
          <label class="block text-[10px] text-gray-500 font-bold mb-1 uppercase">外挂 RAG 知识库</label>
          <select 
            :value="selectedKbId"
            @change="emit('updateKb', ($event.target as HTMLSelectElement).value)"
            class="w-full border rounded p-1.5 text-xs focus:outline-none transition-colors"
            :class="isDark ? 'bg-gray-950 border-gray-800 text-gray-300' : 'bg-slate-50 border-slate-200 text-slate-700'"
          >
            <option value="">暂不绑定知识库</option>
            <option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">
              {{ kb.name }}
            </option>
          </select>
        </div>

        <!-- Tools Toggles -->
        <div>
          <label class="block text-[10px] text-gray-500 font-bold mb-1 uppercase">可用插件/工具 (Agent Tools)</label>
          <div class="space-y-1.5 max-h-[100px] overflow-y-auto pr-1">
            <label 
              v-for="tool in [
                { id: 'tool-web-search', name: 'Google Search' },
                { id: 'tool-python-sandbox', name: 'Python Sandbox' },
                { id: 'tool-vector-db', name: 'Vector DB Retriever' }
              ]"
              :key="tool.id"
              class="flex items-center space-x-2 cursor-pointer text-gray-400 hover:text-white"
            >
              <input 
                type="checkbox" 
                :checked="enabledTools.includes(tool.id)"
                @change="handleToolToggle(tool.id)"
                class="rounded border-gray-800 bg-gray-950 text-indigo-650 focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
              >
              <span class="text-xs" :class="isDark ? 'text-gray-400' : 'text-slate-600'">{{ tool.name }}</span>
            </label>
          </div>
        </div>
      </div>
        <!-- User Profile & Menu -->
      <div class="relative">
        <!-- Floating Menu Backdrop -->
        <div 
          v-if="isMenuOpen" 
          @click="isMenuOpen = false" 
          class="fixed inset-0 z-40"
        ></div>

        <!-- Floating Pop-up Menu -->
        <div 
          v-if="isMenuOpen"
          class="absolute bottom-12 left-0 right-0 z-50 rounded-md border p-1 shadow-lg text-[11px] transition-all duration-150 flex flex-col space-y-0.5"
          :class="isDark 
            ? 'bg-slate-900 border-slate-800 text-slate-200 shadow-slate-950/50' 
            : 'bg-white border-slate-200 text-slate-700 shadow-slate-200/50'"
        >
          <button 
            @click="isMenuOpen = false; showActionToast('下载手机应用')"
            class="flex items-center space-x-2 w-full p-2 text-left rounded hover:bg-slate-500/10 transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5 text-slate-400">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
            </svg>
            <span>下载手机应用</span>
          </button>
          
          <button 
            @click="isMenuOpen = false; emit('openSettings')"
            class="flex items-center space-x-2 w-full p-2 text-left rounded hover:bg-slate-500/10 transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5 text-slate-400">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.828c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827a1.125 1.125 0 01.26 1.43l-1.297 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>系统设置</span>
          </button>
          
          <button 
            @click="isMenuOpen = false; showActionToast('帮助与反馈')"
            class="flex items-center space-x-2 w-full p-2 text-left rounded hover:bg-slate-500/10 transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5 text-slate-400">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
            <span>帮助与反馈</span>
          </button>
          
          <div class="h-[1px]" :class="isDark ? 'bg-slate-800' : 'bg-slate-100'"></div>
          
          <button 
            @click="isMenuOpen = false; emit('logout')"
            class="flex items-center space-x-2 w-full p-2 text-left rounded text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
            <span>退出登录</span>
          </button>
        </div>

        <!-- Profile Bar Item -->
        <div 
          @click="isMenuOpen = !isMenuOpen"
          class="flex items-center justify-between p-2 rounded-md border transition-colors cursor-pointer select-none"
          :class="isDark 
            ? 'bg-slate-900/30 border-slate-900 hover:bg-slate-900/60' 
            : 'bg-white border-slate-200 hover:bg-slate-50 shadow-sm'"
        >
          <div class="flex items-center space-x-2.5 min-w-0">
            <div 
              class="w-7 h-7 rounded border flex items-center justify-center font-bold text-xs flex-shrink-0"
              :class="isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-200 border-slate-350 text-slate-700'"
            >
              U
            </div>
            <div class="min-w-0 pr-1 text-left">
              <div class="text-xs font-bold truncate" :class="isDark ? 'text-slate-300' : 'text-slate-800'">DevSquad User</div>
              <div class="text-[9px] truncate text-slate-500" :class="isDark ? 'text-slate-500' : 'text-slate-400'">user@devsquad.com</div>
            </div>
          </div>
          <div class="text-slate-500 text-sm font-bold flex-shrink-0">
            ···
          </div>
        </div>
      </div>

      <!-- Floating Toast Message in Sidebar -->
      <div 
        v-if="toastMessage" 
        class="fixed bottom-4 left-4 px-3 py-1.5 bg-slate-800 border border-slate-700 text-slate-100 text-[10px] rounded shadow-lg z-50 flex items-center space-x-1.5"
      >
        <span class="w-1 h-1 bg-emerald-500 rounded-full animate-ping"></span>
        <span>{{ toastMessage }}</span>
      </div>
    </div>
  </div>
</template>
