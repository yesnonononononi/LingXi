<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { chatApi, AuthAPI } from '../../services/api';
import type { ChatSession, ModelConfig, KnowledgeBase, ChatMessage } from '../../types/chat';
import Sidebar from '../../components/chat/Sidebar.vue';
import ModelHeader from '../../components/chat/ModelHeader.vue';
import WelcomeView from '../../components/chat/WelcomeView.vue';
import ChatMessageItem from '../../components/chat/ChatMessageItem.vue';
import ChatInputArea from '../../components/chat/ChatInputArea.vue';

const router = useRouter();

const props = defineProps<{
  sessions?: ChatSession[];
  activeSessionId?: string | null;
  models?: ModelConfig[];
  knowledgeBases?: KnowledgeBase[];
  selectedModelId?: string | number;
  selectedKbId?: string;
  enabledTools?: string[];
  activeSession?: ChatSession | null;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectSession', id: string): void;
  (e: 'newSession'): void;
  (e: 'deleteSession', id: string): void;
  (e: 'renameSession', id: string, name: string): void;
  (e: 'updateModel', modelId: string | number): void;
  (e: 'updateKb', kbId: string): void;
  (e: 'updateTools', tools: string[]): void;
  (e: 'sendMessage', text: string, isDeepThink: boolean, isHybridSearch: boolean): void;
  (e: 'switchBranch', messageId: string, index: number): void;
  (e: 'editMessage', messageId: string, newText: string): void;
  (e: 'toggleTool', toolId: string): void;
  (e: 'toggleTheme'): void;
  (e: 'logout'): void;
  (e: 'openSettings'): void;
}>();

// 内置 fallback 独立响应式状态 (当无父组件透传时生效)
const localSessions = ref<ChatSession[]>([]);
const localActiveId = ref<string | null>(null);
const localModels = ref<ModelConfig[]>([]);
const localKbs = ref<KnowledgeBase[]>([]);
const localSelectedModel = ref<string | number>('deepseek-r1');
const localSelectedKb = ref('');
const isLocalDark = ref(true);

const displaySessions = computed(() => props.sessions ?? localSessions.value);
const displayActiveId = computed(() => props.activeSessionId ?? localActiveId.value);
const displayModels = computed(() => props.models ?? localModels.value);
const displayKbs = computed(() => props.knowledgeBases ?? localKbs.value);
const displaySelectedModel = computed(() => props.selectedModelId ?? localSelectedModel.value);
const displaySelectedKb = computed(() => props.selectedKbId ?? localSelectedKb.value);
const displayIsDark = computed(() => props.isDark ?? isLocalDark.value);

const currentActiveSession = computed(() => {
  if (props.activeSession !== undefined) return props.activeSession;
  return localSessions.value.find(s => s.id === localActiveId.value) || null;
});

onMounted(async () => {
  if (!props.sessions) {
    localModels.value = await chatApi.fetchModels();
    localKbs.value = await chatApi.fetchKnowledgeBases();
    localSessions.value = await chatApi.fetchSessions();
    if (localModels.value.length > 0) localSelectedModel.value = localModels.value[0].id;
    if (localSessions.value.length > 0) localActiveId.value = localSessions.value[0].id;
  }
});

const isSidebarCollapsed = ref(false);
const inputAreaRef = ref<InstanceType<typeof ChatInputArea> | null>(null);
const messagesContainerRef = ref<HTMLDivElement | null>(null);
const isSending = ref(false);

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainerRef.value) {
      messagesContainerRef.value.scrollTop = messagesContainerRef.value.scrollHeight;
    }
  });
};

watch(() => currentActiveSession.value?.messages, () => {
  scrollToBottom();
}, { deep: true });

const handleSelectSession = (id: string) => {
  if (props.sessions) emit('selectSession', id);
  else localActiveId.value = id;
};

const handleNewSession = async () => {
  if (props.sessions) {
    emit('newSession');
  } else {
    const session = await chatApi.createNewSession(localSelectedModel.value, localSelectedKb.value);
    localSessions.value.unshift(session);
    localActiveId.value = session.id;
  }
};

const handleDeleteSession = async (id: string) => {
  if (props.sessions) {
    emit('deleteSession', id);
  } else {
    const idx = localSessions.value.findIndex(s => s.id === id);
    if (idx !== -1) localSessions.value.splice(idx, 1);
    if (localActiveId.value === id) {
      localActiveId.value = localSessions.value.length > 0 ? localSessions.value[0].id : null;
    }
    await chatApi.deleteSession(id);
  }
};

const handleRenameSession = async (id: string, name: string) => {
  if (props.sessions) {
    emit('renameSession', id, name);
  } else {
    const session = localSessions.value.find(s => s.id === id);
    if (session) session.title = name;
    await chatApi.renameSession(id, name);
  }
};

const handleLogout = async () => {
  await AuthAPI.logout();
  localStorage.removeItem('token');
  emit('logout');
  if (router) router.push('/login');
};

const handleSendMessage = async (text: string, isDeepThink: boolean, isHybridSearch: boolean) => {
  isSending.value = true;
  if (props.sessions) {
    emit('sendMessage', text, isDeepThink, isHybridSearch);
  } else {
    if (!localActiveId.value) await handleNewSession();
    if (!localActiveId.value) return;

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    currentActiveSession.value?.messages.push(userMsg);

    await chatApi.sendMessageStream(
      localActiveId.value,
      text,
      (updatedMsg: ChatMessage) => {
        if (!currentActiveSession.value) return;
        const msgIdx = currentActiveSession.value.messages.findIndex(m => m.id === updatedMsg.id);
        if (msgIdx !== -1) {
          currentActiveSession.value.messages[msgIdx] = { ...updatedMsg };
        } else {
          currentActiveSession.value.messages.push({ ...updatedMsg });
        }
      }
    );
  }
  scrollToBottom();
  isSending.value = false;
};

const handleSelectPrompt = (promptText: string) => {
  if (inputAreaRef.value) {
    inputAreaRef.value.setInputText(promptText);
  }
};
</script>

<template>
  <div :class="['flex h-screen w-screen overflow-hidden font-sans', displayIsDark ? 'bg-[#0b0f17] text-gray-100 dark' : 'bg-gray-50 text-gray-900 light']">
    
    <!-- DeepSeek 风格侧边栏 -->
    <Sidebar
      :sessions="displaySessions"
      :activeSessionId="displayActiveId"
      :isCollapsed="isSidebarCollapsed"
      :isDark="displayIsDark"
      @selectSession="handleSelectSession"
      @newSession="handleNewSession"
      @deleteSession="handleDeleteSession"
      @renameSession="handleRenameSession"
      @toggleCollapse="isSidebarCollapsed = !isSidebarCollapsed"
      @openSettings="emit('openSettings')"
      @logout="handleLogout"
    />

    <!-- 主对话聊天视窗区域 -->
    <div class="flex-1 flex flex-col h-full overflow-hidden relative">
      
      <!-- Top Model Bar -->
      <ModelHeader
        :models="displayModels"
        :knowledgeBases="displayKbs"
        :selectedModelId="displaySelectedModel"
        :selectedKbId="displaySelectedKb"
        :isDark="displayIsDark"
        @updateModel="(id) => emit('updateModel', id)"
        @updateKb="(id) => emit('updateKb', id)"
        @toggleTheme="emit('toggleTheme')"
        @openSettings="emit('openSettings')"
      />

      <!-- Message Container & Scroll Container -->
      <div
        ref="messagesContainerRef"
        class="flex-1 overflow-y-auto scrollbar-thin relative flex flex-col"
      >
        <!-- Welcome View if No Messages -->
        <WelcomeView
          v-if="!currentActiveSession?.messages?.length"
          :isDark="displayIsDark"
          @selectPrompt="handleSelectPrompt"
        />

        <!-- Message List -->
        <div v-else class="flex-1 max-w-4xl mx-auto w-full py-4 px-2 sm:px-6 space-y-2">
          <ChatMessageItem
            v-for="msg in currentActiveSession.messages"
            :key="msg.id"
            :message="msg"
            :isDark="displayIsDark"
            @switchBranch="(msgId, idx) => emit('switchBranch', msgId, idx)"
            @editMessage="(msgId, text) => emit('editMessage', msgId, text)"
          />
        </div>
      </div>

      <!-- Floating Bottom Input Bar -->
      <ChatInputArea
        ref="inputAreaRef"
        :isSending="isSending"
        :isDark="displayIsDark"
        @sendMessage="handleSendMessage"
        @stopGeneration="isSending = false"
      />

    </div>
  </div>
</template>
