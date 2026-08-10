<script setup lang="ts">
import { ref } from 'vue';
import { AuthAPI } from '../../services/api';

defineProps<{
  sessions?: any[];
  activeSessionId?: string | null;
  models?: any[];
  knowledgeBases?: any[];
  selectedModelId?: string;
  selectedKbId?: string;
  enabledTools?: string[];
  activeSession?: any;
  isDark?: boolean;
}>();

const emit = defineEmits([
  'selectSession', 'newSession', 'deleteSession', 'updateModel', 
  'updateKb', 'updateTools', 'sendMessage', 'switchBranch', 
  'editMessage', 'toggleTool', 'toggleTheme', 'logout', 'openSettings'
]);

const inputText = ref('');

const handleSend = () => {
  if (!inputText.value.trim()) return;
  emit('sendMessage', inputText.value, false, false);
  inputText.value = '';
};

const handleLogout = async () => {
  await AuthAPI.logout();
  emit('logout');
};
</script>

<template>
  <div class="flex h-screen bg-gray-950 text-white">
    <!-- Sidebar -->
    <div class="w-64 bg-gray-900 border-r border-gray-800 flex flex-col justify-between p-4">
      <div>
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-xl font-bold tracking-wider text-indigo-400">灵 犀 Agent</h1>
          <button @click="emit('newSession')" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 rounded-md text-xs font-semibold">
            + 新建
          </button>
        </div>
        <div class="space-y-2">
          <div 
            v-for="session in sessions" 
            :key="session.id"
            @click="emit('selectSession', session.id)"
            :class="['p-3 rounded-lg cursor-pointer text-sm transition', activeSessionId === session.id ? 'bg-gray-800 text-indigo-300 font-medium' : 'hover:bg-gray-800/50 text-gray-400']"
          >
            {{ session.title || '新对话' }}
          </div>
        </div>
      </div>
      <div>
        <button @click="handleLogout" class="w-full py-2 bg-red-950/50 hover:bg-red-900/60 text-red-300 border border-red-800/50 rounded-lg text-sm transition">
          退出登录
        </button>
      </div>
    </div>

    <!-- Main Chat Window -->
    <div class="flex-1 flex flex-col">
      <!-- Top Bar -->
      <div class="h-14 border-b border-gray-800 px-6 flex items-center justify-between bg-gray-900/50">
        <div class="text-sm font-medium text-gray-300">
          模型: <span class="text-indigo-400 font-semibold">{{ selectedModelId || 'Gemini 1.5 Pro' }}</span>
        </div>
        <button @click="emit('openSettings')" class="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-md border border-gray-700">
          设置
        </button>
      </div>

      <!-- Messages Stream -->
      <div class="flex-1 overflow-y-auto p-6 space-y-4">
        <div v-if="!activeSession?.messages?.length" class="h-full flex items-center justify-center text-gray-500 text-sm">
          开始与灵犀 Agent 进行交互吧
        </div>
        <div 
          v-for="msg in activeSession?.messages || []" 
          :key="msg.id"
          :class="['p-4 rounded-xl max-w-2xl', msg.role === 'user' ? 'bg-indigo-600/30 ml-auto border border-indigo-500/30' : 'bg-gray-900 border border-gray-800']"
        >
          <div class="text-xs text-gray-400 mb-1 font-semibold">{{ msg.role === 'user' ? '你' : '灵犀 Agent' }}</div>
          <div class="text-sm text-gray-200 leading-relaxed">{{ msg.content }}</div>
        </div>
      </div>

      <!-- Input Area -->
      <div class="p-4 border-t border-gray-800 bg-gray-900/40">
        <div class="max-w-4xl mx-auto flex gap-2">
          <input 
            v-model="inputText"
            @keyup.enter="handleSend"
            type="text" 
            placeholder="发送消息..." 
            class="flex-1 px-4 py-3 rounded-xl bg-gray-900 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
          />
          <button @click="handleSend" class="px-5 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-semibold text-white shadow-lg transition">
            发送
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
