<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { chatApi } from './services/api';
import type { ChatSession, ModelConfig, KnowledgeBase, ChatMessage } from './types/chat';
import LoginView from './views/auth/LoginView.vue';
import ChatView from './views/chat/ChatView.vue';
import SettingsModal from './views/settings/SettingsModal.vue';

// 核心状态
const sessions = ref<ChatSession[]>([]);
const activeSessionId = ref<string | null>(null);
const models = ref<ModelConfig[]>([]);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const currentPage = ref<'login' | 'chat'>('login');
const isSettingsOpen = ref(false);

// 当前新建对话所用的默认配置
const selectedModelId = ref('');
const selectedKbId = ref('');
const enabledTools = ref<string[]>(['tool-web-search']); // 默认开启网络检索
const isSending = ref(false);
const isDark = ref(localStorage.getItem('theme') !== 'light'); // 默认 true (dark 模式)

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

const activeSession = computed(() => {
  return sessions.value.find(s => s.id === activeSessionId.value) || null;
});

// 初始化数据
const initData = async () => {
  models.value = await chatApi.fetchModels();
  knowledgeBases.value = await chatApi.fetchKnowledgeBases();
  sessions.value = await chatApi.fetchSessions();
  
  if (models.value.length > 0) {
    selectedModelId.value = models.value[0].id;
  }
  if (sessions.value.length > 0) {
    activeSessionId.value = sessions.value[0].id;
  }
};

onMounted(() => {
  initData();
});

// 会话生命周期管理
const selectSession = (id: string) => {
  if (isSending.value) return;
  activeSessionId.value = id;
  const session = sessions.value.find(s => s.id === id);
  if (session) {
    selectedModelId.value = session.modelId;
    selectedKbId.value = session.knowledgeBaseId || '';
    enabledTools.value = [...session.activeTools];
  }
};

const newSession = async () => {
  if (isSending.value) return;
  const session = await chatApi.createNewSession(
    selectedModelId.value,
    selectedKbId.value || undefined,
    [...enabledTools.value]
  );
  sessions.value.unshift(session);
  activeSessionId.value = session.id;
};

const deleteSession = async (id: string) => {
  if (isSending.value) return;
  const success = await chatApi.deleteSession(id);
  if (success) {
    const idx = sessions.value.findIndex(s => s.id === id);
    if (idx !== -1) sessions.value.splice(idx, 1);
    
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value.length > 0 ? sessions.value[0].id : null;
    }
  }
};

const clearSessions = () => {
  sessions.value = [];
  activeSessionId.value = null;
  newSession();
};

// 工具与配置修改
const updateModel = (modelId: string) => {
  selectedModelId.value = modelId;
  if (activeSession.value) {
    activeSession.value.modelId = modelId;
  }
};

const updateKb = (kbId: string) => {
  selectedKbId.value = kbId;
  if (activeSession.value) {
    activeSession.value.knowledgeBaseId = kbId || undefined;
  }
};

const updateTools = (tools: string[]) => {
  enabledTools.value = tools;
  if (activeSession.value) {
    activeSession.value.activeTools = [...tools];
  }
};

const toggleTool = (toolId: string) => {
  const idx = enabledTools.value.indexOf(toolId);
  if (idx !== -1) {
    enabledTools.value.splice(idx, 1);
  } else {
    enabledTools.value.push(toolId);
  }
  if (activeSession.value) {
    activeSession.value.activeTools = [...enabledTools.value];
  }
};

// 发送新消息逻辑
const handleSendMessage = async (
  text: string, 
  isDeepThink: boolean, 
  isHybridSearch: boolean
) => {
  if (!activeSessionId.value) {
    // 若没有活跃会话，先创建一个
    await newSession();
  }
  if (!activeSessionId.value || isSending.value) return;

  isSending.value = true;
  
  // 暂时同步状态：根据参数调整底座模型和知识库
  if (isDeepThink) {
    updateModel('agent-backend'); // 智能后端模型
  }
  if (isHybridSearch) {
    updateTools([...enabledTools.value, 'tool-vector-db']);
  }

  try {
    // 调用 api 服务以流式模拟返回
    await chatApi.sendMessageStream(
      activeSessionId.value,
      text,
      (updatedMsg: ChatMessage) => {
        if (!activeSession.value) return;
        const msgIdx = activeSession.value.messages.findIndex(m => m.id === updatedMsg.id);
        if (msgIdx !== -1) {
          activeSession.value.messages[msgIdx] = { ...updatedMsg };
        }
      }
    );
  } catch (error) {
    console.error('发送消息流发生错误:', error);
  } finally {
    isSending.value = false;
  }
};

// 切换历史版本分支
const handleSwitchBranch = async (messageId: string, index: number) => {
  if (!activeSessionId.value || isSending.value) return;
  const updatedMsg = await chatApi.switchMessageBranch(activeSessionId.value, messageId, index);
  if (updatedMsg && activeSession.value) {
    const msgIdx = activeSession.value.messages.findIndex(m => m.id === messageId);
    if (msgIdx !== -1) {
      activeSession.value.messages[msgIdx] = { ...updatedMsg };
    }
  }
};

// 修改用户输入，生成新分叉分支并重新触发回复流
const handleEditMessage = async (messageId: string, newText: string) => {
  if (isSending.value || !activeSession.value) return;

  const msgIdx = activeSession.value.messages.findIndex(m => m.id === messageId);
  if (msgIdx === -1) return;

  const targetMsg = activeSession.value.messages[msgIdx];
  if (!targetMsg.branches) targetMsg.branches = [targetMsg.content];
  
  // 添加新的分支文本
  targetMsg.branches.push(newText);
  const newBranchIdx = targetMsg.branches.length - 1;
  targetMsg.activeBranchIndex = newBranchIdx;
  targetMsg.content = newText;

  // 截断该消息以后的所有对话（模拟分叉）
  activeSession.value.messages = activeSession.value.messages.slice(0, msgIdx + 1);

  // 重新触发 Agent 响应
  handleSendMessage(newText, false, false);
};
</script>

<template>
  <LoginView 
    v-if="currentPage === 'login'" 
    :isDark="isDark"
    @loginSuccess="currentPage = 'chat'"
    @toggleTheme="toggleTheme"
  />
  <ChatView 
    v-else
    :sessions="sessions"
    :activeSessionId="activeSessionId"
    :models="models"
    :knowledgeBases="knowledgeBases"
    :selectedModelId="selectedModelId"
    :selectedKbId="selectedKbId"
    :enabledTools="enabledTools"
    :activeSession="activeSession"
    :isDark="isDark"
    @selectSession="selectSession"
    @newSession="newSession"
    @deleteSession="deleteSession"
    @updateModel="updateModel"
    @updateKb="updateKb"
    @updateTools="updateTools"
    @sendMessage="handleSendMessage"
    @switchBranch="handleSwitchBranch"
    @editMessage="handleEditMessage"
    @toggleTool="toggleTool"
    @toggleTheme="toggleTheme"
    @logout="currentPage = 'login'"
    @openSettings="isSettingsOpen = true"
  />

  <!-- Settings Modal -->
  <SettingsModal 
    v-if="isSettingsOpen" 
    :isDark="isDark"
    @close="isSettingsOpen = false"
    @toggleTheme="toggleTheme"
    @clearSessions="clearSessions"
  />
</template>

<style>
/* 全局样式覆盖 */
body {
  margin: 0;
  background-color: #000000;
}
</style>
