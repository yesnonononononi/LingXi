<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { ChatSession, ModelConfig, KnowledgeBase } from '../types/chat';
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  session: ChatSession | null;
  models: ModelConfig[];
  knowledgeBases: KnowledgeBase[];
  selectedModelId: string;
  selectedKbId: string;
  enabledTools: string[];
  isDark: boolean;
}>();

const emit = defineEmits<{
  (e: 'sendMessage', text: string, isDeepThink: boolean, isHybridSearch: boolean): void;
  (e: 'switchBranch', messageId: string, index: number): void;
  (e: 'editMessage', messageId: string, newText: string): void;
  (e: 'updateModel', modelId: string): void;
  (e: 'updateKb', kbId: string): void;
  (e: 'toggleTool', toolId: string): void;
  (e: 'toggleTheme'): void;
}>();

const inputText = ref('');
const isDeepThink = ref(false);
const isHybridSearch = ref(false);
const chatContainer = ref<HTMLDivElement | null>(null);

// 附件上传状态模拟 (多模态文档解析亮点)
const uploadedFileName = ref<string | null>(null);
const isParsingFile = ref(false);

const handleUploadClick = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx,.xlsx,.txt';
  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      uploadedFileName.value = file.name;
      isParsingFile.value = true;
      // 模拟后端 PDF 解析冷启动与切片过程
      setTimeout(() => {
        isParsingFile.value = false;
      }, 1500);
    }
  };
  input.click();
};

const removeFile = () => {
  uploadedFileName.value = null;
  isParsingFile.value = false;
};

const handleSend = () => {
  if (!inputText.value.trim() && !uploadedFileName.value) return;
  
  let text = inputText.value;
  if (uploadedFileName.value) {
    text = `[文档附件: ${uploadedFileName.value}] ${text || '请帮我解析这个文档。'}`;
  }

  emit('sendMessage', text, isDeepThink.value, isHybridSearch.value);
  inputText.value = '';
  uploadedFileName.value = null;
  
  scrollToBottom();
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  });
};

watch(() => props.session?.messages.length, () => {
  scrollToBottom();
});

watch(() => props.session?.id, () => {
  scrollToBottom();
});

const selectModeFromWelcome = (modelCategory: 'speed' | 'intelligence' | 'specialized') => {
  const model = props.models.find(m => m.category === modelCategory);
  if (model) {
    emit('updateModel', model.id);
  }
  
  if (modelCategory === 'specialized') {
    isDeepThink.value = true;
    isHybridSearch.value = true;
    // 自动挂载第一个知识库
    if (props.knowledgeBases.length > 0) {
      emit('updateKb', props.knowledgeBases[0].id);
    }
  } else {
    isDeepThink.value = modelCategory === 'intelligence';
    isHybridSearch.value = false;
    emit('updateKb', '');
  }
};
</script>

<template>
  <div 
    class="flex-grow flex flex-col h-full min-w-0 font-sans transition-colors duration-200"
    :class="isDark ? 'bg-black text-slate-200' : 'bg-white text-slate-850'"
  >
    
    <!-- Top Header (常驻网页顶部模型路由与主题栏) -->
    <div 
      class="h-14 border-b flex items-center justify-between px-6 transition-colors duration-200"
      :class="isDark ? 'bg-black border-slate-900' : 'bg-white border-slate-200'"
    >
      <div class="flex items-center space-x-3 text-xs">
        <template v-if="session">
          <span :class="isDark ? 'text-gray-400' : 'text-slate-500'">当前协同 Agent:</span>
          <span class="px-2.5 py-1 font-bold rounded-md flex items-center space-x-1.5 shadow-sm border transition-colors duration-200"
            :class="isDark ? 'bg-slate-900/50 border-slate-800 text-slate-300' : 'bg-white border-slate-250 text-slate-700'">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>{{ models.find(m => m.id === session?.modelId)?.name || '后端架构师' }}</span>
          </span>

          <span v-if="session?.knowledgeBaseId" class="px-2.5 py-1 font-bold rounded-md shadow-sm border transition-colors duration-200"
            :class="isDark ? 'bg-slate-900/50 border-slate-800 text-slate-350' : 'bg-white border-slate-250 text-slate-700'">
            RAG: {{ knowledgeBases.find(k => k.id === session?.knowledgeBaseId)?.name }}
          </span>
        </template>
        <template v-else>
          <span class="font-extrabold text-xs tracking-wider" :class="isDark ? 'text-slate-200' : 'text-slate-800'">
            DevSquad 协同控制台 (DevSquad Console)
          </span>
        </template>
      </div>

      <div class="flex items-center space-x-4 text-xs">
        <!-- Enabled tools quick viewer -->
        <div v-if="session" class="flex items-center space-x-2">
          <span :class="isDark ? 'text-gray-500' : 'text-slate-400'">已调度插件:</span>
          <div class="flex space-x-1.5">
            <span 
              v-for="toolId in session.activeTools" 
              :key="toolId"
              class="px-2 py-0.5 border text-gray-400 rounded-md scale-95 transition-all"
              :class="isDark ? 'bg-gray-950 border-gray-800 text-gray-400' : 'bg-white border-slate-200 text-slate-600 shadow-sm'"
            >
              {{ toolId === 'tool-web-search' ? '联网搜索' : toolId === 'tool-python-sandbox' ? 'Python沙箱' : '向量库' }}
            </span>
            <span v-if="session.activeTools.length === 0" :class="isDark ? 'text-gray-650' : 'text-slate-350'" class="font-mono">None</span>
          </div>
        </div>

        <!-- Theme Switch Button -->
        <button 
          @click="emit('toggleTheme')"
          class="p-1.5 rounded-md border transition-all duration-200 active:scale-95 cursor-pointer"
          :class="isDark 
            ? 'bg-gray-900 border-gray-800 hover:border-gray-700 text-yellow-400 hover:text-yellow-300' 
            : 'bg-white border-slate-200 hover:border-slate-300 text-indigo-600 shadow-sm'"
          title="切换背景主题"
        >
          <!-- Sun (Light Mode to Switch to Dark) -->
          <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m0 13.5V21m9.75-9h-2.25m-13.5 0H3m16.5-6.75l-1.59 1.59M5.25 18.75l1.59-1.59m0-10.32l-1.59-1.59m13.18 13.18l-1.59-1.59M12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9z" />
          </svg>
          <!-- Moon (Dark Mode to Switch to Light) -->
          <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Main Message Area -->
    <div 
      ref="chatContainer"
      class="flex-grow overflow-y-auto"
    >
      <!-- Welcome Screen (无消息时) -->
      <div 
        v-if="!session || session.messages.length === 0"
        class="max-w-2xl mx-auto h-full flex flex-col justify-center px-4 py-8 space-y-8 select-none"
      >
        <!-- Title -->
        <div class="text-center space-y-3">
          <div 
            class="inline-flex p-3 rounded-xl border transition-colors shadow-sm"
            :class="isDark ? 'bg-slate-900 border-slate-800 text-slate-350' : 'bg-slate-800 border-slate-700 text-white'"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-8 h-8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </div>
          <h1 
            class="text-2xl font-bold tracking-tight transition-colors duration-200"
            :class="isDark ? 'text-slate-100' : 'text-slate-800'"
          >
            我是 DevSquad 协同助手
          </h1>
          <p class="text-xs max-w-sm mx-auto transition-colors" :class="isDark ? 'text-slate-500' : 'text-slate-450'">
            多 Agent 团队联合坐镇，配备高并发微服务、代码编译沙盒与企业文档 RAG 语义检索，为企业开发全流程降本增效。
          </p>
        </div>

        <!-- Mode Select Cards (页面样式参考 DeepSeek/Gemini) -->
        <div class="grid grid-cols-3 gap-3">
          <button 
            @click="selectModeFromWelcome('speed')"
            class="flex flex-col items-start p-3 border rounded-md text-left transition-all active:scale-[0.98] cursor-pointer"
            :class="isDark 
              ? 'bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/20 text-slate-350' 
              : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-750 shadow-sm'"
          >
            <span class="text-xs font-bold text-cyan-600 flex items-center space-x-1 dark:text-cyan-400">
              💻 <span>前端开发专家</span>
            </span>
            <span class="text-[10px] mt-1" :class="isDark ? 'text-slate-500' : 'text-slate-450'">调度前端 Agent，联调 CSS/Tailwind 布局与 TS/Vue 组件类型与样式提效</span>
          </button>

          <button 
            @click="selectModeFromWelcome('intelligence')"
            class="flex flex-col items-start p-3 border rounded-md text-left transition-all active:scale-[0.98] cursor-pointer"
            :class="isDark 
              ? 'bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/20 text-slate-350' 
              : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-750 shadow-sm'"
          >
            <span class="text-xs font-bold text-slate-800 flex items-center space-x-1 dark:text-slate-300">
              ⚙️ <span>后端架构专家</span>
            </span>
            <span class="text-[10px] mt-1" :class="isDark ? 'text-slate-500' : 'text-slate-450'">调度后端 Agent，处理高并发限流、消息队列、混合 RAG 检索与代码沙盒执行</span>
          </button>

          <button 
            @click="selectModeFromWelcome('specialized')"
            class="flex flex-col items-start p-3 border rounded-md text-left transition-all active:scale-[0.98] cursor-pointer"
            :class="isDark 
              ? 'bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/20 text-slate-350' 
              : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-750 shadow-sm'"
          >
            <span class="text-xs font-bold text-emerald-600 flex items-center space-x-1 dark:text-emerald-400">
              ☸️ <span>云原生与检索</span>
            </span>
            <span class="text-[10px] mt-1" :class="isDark ? 'text-slate-500' : 'text-slate-450'">挂载私有部署知识库，召回防火墙白名单与 K8s 部署规范文档</span>
          </button>
        </div>
      </div>

      <!-- Messages Stream -->
      <div v-else class="w-full">
        <MessageItem 
          v-for="msg in session.messages" 
          :key="msg.id" 
          :message="msg"
          :isDark="isDark"
          @switchBranch="(msgId, idx) => emit('switchBranch', msgId, idx)"
          @editMessage="(msgId, txt) => emit('editMessage', msgId, txt)"
        />
      </div>
    </div>

    <!-- Input Footer Controls (输入区控制) -->
    <div 
      class="p-4 border-t transition-colors duration-200"
      :class="isDark ? 'border-gray-900 bg-gray-950/30' : 'border-slate-200 bg-slate-100/30'"
    >
      <div class="max-w-3xl mx-auto space-y-2">
        <!-- Input Tools helper row -->
        <div 
          v-if="enabledTools.length > 0" 
          class="flex items-center space-x-2 text-xs"
          :class="isDark ? 'text-gray-500' : 'text-slate-400'"
        >
          <span>待调度插件:</span>
          <div class="flex gap-1.5">
            <span 
              v-for="toolId in enabledTools" 
              :key="toolId"
              class="px-2 py-0.5 border hover:border-rose-900 hover:text-rose-400 rounded-md cursor-pointer flex items-center space-x-1 transition-all"
              :class="isDark ? 'bg-gray-900 border-gray-800' : 'bg-white border-slate-200 text-slate-600 shadow-sm'"
              @click="emit('toggleTool', toolId)"
            >
              <span>{{ toolId === 'tool-web-search' ? 'Google Search' : toolId === 'tool-python-sandbox' ? 'Python Sandbox' : 'Vector Retriever' }}</span>
              <span class="text-[9px]">×</span>
            </span>
          </div>
        </div>

        <!-- File parser preview (多模态解析中...) -->
        <div 
          v-if="uploadedFileName" 
          class="flex items-center justify-between p-2 border rounded-md text-xs"
          :class="isDark ? 'bg-gray-950 border-gray-800' : 'bg-white border-slate-200 shadow-sm'"
        >
          <div class="flex items-center space-x-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4 text-indigo-400">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span class="font-bold" :class="isDark ? 'text-gray-300' : 'text-slate-700'">{{ uploadedFileName }}</span>
            <span 
              v-if="isParsingFile" 
              class="text-[10px] text-indigo-400 animate-pulse font-mono"
            >
              [后端解析中：PDF 页面提取与特征编码...]
            </span>
            <span v-else class="text-[10px] text-emerald-400 font-mono">
              [解析就绪：24 个切片已载入向量缓冲区]
            </span>
          </div>
          <button 
            @click="removeFile" 
            class="text-gray-500 hover:text-white font-bold"
          >
            删除
          </button>
        </div>

        <!-- Main Input Capsule Card -->
        <div 
          class="border rounded-lg p-2 transition-all duration-200"
          :class="isDark 
            ? 'border-gray-800 bg-gray-950/80 focus-within:border-gray-700/80' 
            : 'border-slate-200 bg-white focus-within:border-slate-350 shadow-md'"
        >
          <textarea
            v-model="inputText"
            @keydown="handleKeydown"
            placeholder="给 AetherAgent 发送消息... (Shift+Enter 换行)"
            rows="2"
            class="w-full bg-transparent border-0 text-sm placeholder-gray-600 focus:ring-0 focus:outline-none resize-none p-1 transition-colors"
            :class="isDark ? 'text-gray-200' : 'text-slate-800'"
          ></textarea>

          <!-- Input Tools & Buttons -->
          <div 
            class="flex items-center justify-between border-t pt-2 mt-1"
            :class="isDark ? 'border-gray-900' : 'border-slate-100'"
          >
            <!-- Left Side Switches -->
            <div class="flex items-center space-x-3 text-xs">
              <!-- Upload Document -->
              <button 
                @click="handleUploadClick"
                class="p-1 rounded transition-colors cursor-pointer"
                :class="isDark ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-900' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'"
                title="上传 PDF 等文档外挂解析"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32a1.5 1.5 0 01-2.12-2.121L16.273 8.27" />
                </svg>
              </button>

              <!-- Deep Think Switch -->
              <button 
                @click="isDeepThink = !isDeepThink"
                class="flex items-center space-x-1.5 px-2 py-1 rounded border transition-all duration-200 font-semibold cursor-pointer"
                :class="isDeepThink 
                  ? 'bg-blue-950/30 border-blue-800 text-blue-400 shadow shadow-blue-500/10' 
                  : (isDark ? 'border-gray-900 bg-gray-900/40 text-gray-500 hover:text-gray-400' : 'border-slate-200 bg-slate-50 text-slate-400 hover:text-slate-600 shadow-sm')"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75c0 .414-.168.789-.439 1.061L9 11.25V18m0 0h.008v.008H9V18zm0 0H5.25a2.25 2.25 0 01-2.25-2.25V6a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 6v3.75M9.75 9.75h4.5M9.75 9.75V9m4.5 0.75c0 .414.168.789.439 1.061L15 11.25V18m0 0h-.008v.008H15V18zm0 0h3.75a2.25 2.25 0 002.25-2.25V6" />
                </svg>
                <span>深度思考</span>
              </button>

              <!-- Hybrid Search Switch -->
              <button 
                @click="isHybridSearch = !isHybridSearch"
                class="flex items-center space-x-1.5 px-2 py-1 rounded border transition-all duration-200 font-semibold cursor-pointer"
                :class="isHybridSearch 
                  ? 'bg-emerald-950/30 border-emerald-800 text-emerald-400 shadow shadow-emerald-500/10' 
                  : (isDark ? 'border-gray-900 bg-gray-900/40 text-gray-500 hover:text-gray-400' : 'border-slate-200 bg-slate-50 text-slate-400 hover:text-slate-600 shadow-sm')"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-3.5 h-3.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.637 10.637z" />
                </svg>
                <span>智能检索</span>
              </button>
            </div>

            <!-- Right Side Send Button -->
            <button
              @click="handleSend"
              :disabled="!inputText.trim() && !uploadedFileName"
              class="h-7 w-7 rounded-md flex items-center justify-center transition-all bg-gradient-to-tr from-indigo-500 via-blue-500 to-purple-600 hover:from-indigo-650 hover:to-purple-650 text-white disabled:opacity-40 disabled:from-gray-900 disabled:to-gray-900 disabled:text-gray-600 disabled:shadow-none cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h5.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
