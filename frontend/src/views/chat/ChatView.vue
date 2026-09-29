<script setup lang="ts">
import { ref } from 'vue';
import { useChatView, type ChatViewProps, type ChatViewEmits } from './useChatView';
import Sidebar from '../../components/chat/Sidebar.vue';
import WelcomeView from '../../components/chat/WelcomeView.vue';
import ChatMessageItem from '../../components/chat/ChatMessageItem.vue';
import ChatInputArea from '../../components/chat/ChatInputArea.vue';
import SettingsModal from '../settings/SettingsModal.vue';
import WorkspaceModal from '../../components/chat/WorkspaceModal.vue';
import TeamModal from '../../components/chat/TeamModal.vue';
import ScrollCursorLoader from '../../components/common/ScrollCursorLoader.vue';
import SubSessionsOverviewDrawer from '../../components/chat/SubSessionsOverviewDrawer.vue';
import SubSessionDetailDrawer from '../../components/chat/SubSessionDetailDrawer.vue';
import SubAgentSidePanel from '../../components/chat/SubAgentSidePanel.vue';

const props = defineProps<ChatViewProps>();
const emit = defineEmits<ChatViewEmits>();

const inputAreaRef = ref<InstanceType<typeof ChatInputArea> | null>(null);
const messagesContainerRef = ref<InstanceType<typeof ScrollCursorLoader> | null>(null);

const {
  isSidebarCollapsed,
  isSettingsOpen,
  settingsInitialTab,
  isSending,
  localSelectedTeamId,
  localSelectedAgentId,
  isWorkspaceModalOpen,
  isTeamModalOpen,
  isSubSessionsOverviewOpen,
  selectedSubSessionForDetail,
  activeViewingSubSessionId,
  isSubPanelOpen,
  isSubSessionDetailOpen,
  activeViewingSubSession,
  availableSubSessionItems,
  isLoadingSubMessages,
  subMessagesError,
  displaySessions,
  displayActiveId,
  displayModels,
  displayWorkspaces,
  displayActiveWorkspaceId,
  displaySelectedModel,
  displayAccessMode,
  displayIsDark,
  currentActiveSession,
  displayedMessages,
  hasMessages,
  lastAssistantIndex,
  isNearBottom,
  isLoadingMoreHistory,
  historyLoadError,
  isLoadingCurrentSession,
  sessionLoadError,
  initLoadError,
  currentDisplayTokenInfo,
  canChangeWorkspace,
  handleSelectSession,
  handleNewSession,
  handleDeleteSession,
  handleRenameSession,
  handleExportSession,
  handleClearCurrentSession,
  handleClearSessions,
  handleSelectWorkspace,
  handleOpenNewWorkspace,
  handleSaveWorkspace,
  handleDeleteWorkspace,
  handleOpenTeamModal,
  handleTeamCreated,
  handleOpenModels,
  handleOpenModelEditor,
  handleUpdateModel,
  handleUpdateAccessMode,
  handleOpenSettings,
  handleOpenSettingsTab,
  handleCloseSettings,
  handleModelUpdated,
  handleToggleTheme,
  handleSendMessage,
  handleStopGeneration,
  handleResendMessage,
  handleHumanResponse,
  handleSelectPrompt,
  handleQuickStart,
  handleLoadMoreHistory,
  handleRetryLoadMoreHistory,
  handleRetrySessionLoad,
  handleRetryInit,
  handleRetrySubSessionMessages,
  handleSelectSubSessionOption,
  handleOpenSubSessionDetailFromOverview,
  handleScrollToBottomClick,
  handleMessagesScroll,
  handleMessagesWheel,
  handleTouchStart,
  handleTouchMove,
} = useChatView(props, emit, { inputAreaRef, messagesContainerRef });
</script>

<template>
  <div :class="['relative flex h-screen w-screen overflow-hidden font-sans', displayIsDark ? 'text-gray-100 dark' : 'text-gray-900 light']">

    <!-- 全局纯净背景层 -->
    <div class="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div :class="displayIsDark ? 'absolute inset-0 bg-[#0b0f17]' : 'absolute inset-0 bg-white'"></div>
    </div>

    <!-- DeepSeek 风格侧边栏 -->
    <Sidebar
      :sessions="displaySessions"
      :activeSessionId="displayActiveId"
      :workspaces="displayWorkspaces"
      :activeWorkspaceId="displayActiveWorkspaceId"
      :isCollapsed="isSidebarCollapsed"
      :isDark="displayIsDark"
      @selectSession="handleSelectSession"
      @newSession="handleNewSession"
      @deleteSession="handleDeleteSession"
      @renameSession="handleRenameSession"
      @selectWorkspace="handleSelectWorkspace"
      @newWorkspace="handleOpenNewWorkspace"
      @deleteWorkspace="handleDeleteWorkspace"
      @toggleCollapse="isSidebarCollapsed = !isSidebarCollapsed"
      @openSettings="handleOpenSettings"
      @openModels="handleOpenModels"
      @toggleTheme="handleToggleTheme"
    />

    <!-- 主对话聊天视窗区域 -->
    <div class="relative z-10 flex-1 flex flex-col h-full overflow-hidden">

      <!-- 顶栏：会话标题、子代理协同状态快捷入口与主题切换 -->
      <div :class="['h-12 px-6 border-b shrink-0 flex items-center justify-between z-20 backdrop-blur-xs transition-colors', displayIsDark ? 'border-[#1c2433] bg-[#0b0f17]/80' : 'border-gray-200/80 bg-white/80']">
        <!-- 左侧：会话标题与子代理协作 Session 概览按钮 -->
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="text-xs font-semibold truncate max-w-[240px] text-gray-700 dark:text-gray-200">
            {{ currentActiveSession?.title || '新对话' }}
          </span>

          <!-- 子代理协作 Session 胶囊按钮 (点击展开/收起右侧面板) -->
          <button
            v-if="availableSubSessionItems.length"
            @click="isSubPanelOpen = !isSubPanelOpen"
            :class="[
              'px-2.5 py-1 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer shadow-2xs',
              displayIsDark
                ? 'bg-blue-600/15 border-blue-500/30 text-blue-300 hover:bg-blue-600/25'
                : 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100'
            ]"
            :title="isSubPanelOpen ? '收起右侧子代理轨迹面板' : '展开右侧子代理轨迹面板'"
          >
            <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
            <span>子代理协作</span>
            <span :class="['px-1.5 py-0.2 rounded-full text-[10px] font-mono font-semibold', displayIsDark ? 'bg-blue-500/30 text-blue-200' : 'bg-blue-200 text-blue-800']">
              {{ availableSubSessionItems.length }}
            </span>
          </button>
        </div>

        <!-- 右侧：主题切换与操作 -->
        <div class="flex items-center gap-2">
          <button
            @click="handleToggleTheme"
            :class="[
              'p-1.5 rounded-xl border transition cursor-pointer',
              displayIsDark ? 'bg-[#161b26] border-[#2d3a54] text-yellow-400 hover:bg-[#202738]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
            ]"
            :title="displayIsDark ? '切换到亮色模式' : '切换到暗色模式'"
          >
            <svg v-if="displayIsDark" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 初始化数据加载失败：可见失败态 + 重试（区别于「确实为空」，避免后端宕机时静默显示为空） -->
      <div
        v-if="initLoadError"
        :class="['px-4 py-2 border-b shrink-0 flex items-center justify-between gap-2 text-xs', displayIsDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
      >
        <span>{{ initLoadError }}</span>
        <button
          type="button"
          @click="handleRetryInit"
          :class="['px-2.5 py-1 rounded-lg border text-xs font-medium transition cursor-pointer shrink-0', displayIsDark ? 'border-red-800 text-red-300 hover:bg-red-900/30' : 'border-red-300 text-red-600 hover:bg-red-100']"
        >
          重试
        </button>
      </div>

      <!-- 会话详情加载失败：可见失败态 + 重试 -->
      <div
        v-if="sessionLoadError"
        :class="['px-4 py-2 border-b shrink-0 flex items-center justify-between gap-2 text-xs', displayIsDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
      >
        <span>{{ sessionLoadError }}</span>
        <button
          type="button"
          @click="handleRetrySessionLoad"
          :class="['px-2.5 py-1 rounded-lg border text-xs font-medium transition cursor-pointer shrink-0', displayIsDark ? 'border-red-800 text-red-300 hover:bg-red-900/30' : 'border-red-300 text-red-600 hover:bg-red-100']"
        >
          重试
        </button>
      </div>

      <!-- 中间主体工作区：左侧消息列表 + 右侧子代理会话轨迹与标签面板 (对应红框位置) -->
      <div
        class="transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] flex overflow-hidden relative w-full min-h-0"
        :style="{
          flex: hasMessages ? '1 1 0%' : '0 0 0px'
        }"
      >
        
        <!-- 左侧：消息列表与悬浮吸底控制容器 -->
        <div
          class="relative flex-1 min-w-0 h-full flex flex-col overflow-hidden transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          :style="{
            flex: hasMessages ? '1 1 0%' : '0 0 0px',
            opacity: hasMessages ? 1 : 0,
            pointerEvents: hasMessages ? 'auto' : 'none'
          }"
        >
          <ScrollCursorLoader
            ref="messagesContainerRef"
            class="scrollbar-thin relative flex flex-col flex-1 h-full"
            :style="{
              overflowY: hasMessages ? 'auto' : 'hidden'
            }"
            direction="top"
            :threshold="80"
            :hasMore="!isLoadingCurrentSession && !activeViewingSubSession && !!currentActiveSession?.hasMoreMessages"
            :loading="isLoadingMoreHistory"
            loadingText="正在加载历史消息..."
            @load="handleLoadMoreHistory"
            @scroll="handleMessagesScroll"
            @wheel.passive="handleMessagesWheel"
            @touchstart.passive="handleTouchStart"
            @touchmove.passive="handleTouchMove"
          >
            <!-- 子会话历史查看提示顶条 -->
            <div
              v-if="activeViewingSubSession"
              class="sticky top-0 z-20 px-4 py-2 bg-blue-50/90 dark:bg-blue-950/70 border-b border-blue-200/80 dark:border-blue-900/50 backdrop-blur-md flex items-center justify-between text-xs select-none"
            >
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                <span class="text-gray-500 dark:text-gray-400">正在查看子代理会话历史:</span>
                <span class="font-semibold text-blue-600 dark:text-blue-400">{{ activeViewingSubSession.agentName }}</span>
                <span class="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-[10px] font-mono text-blue-700 dark:text-blue-300">#{{ activeViewingSubSession.id }}</span>
              </div>
              <button
                @click="handleSelectSubSessionOption(null)"
                class="px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shadow-xs"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                <span>返回主会话</span>
              </button>
            </div>

            <div class="flex-1 max-w-3xl mx-auto w-full py-6 px-4 space-y-3">
              <!-- 加载更多历史失败：可见失败态 + 重试（否则转圈消失会让用户误以为「已到底」） -->
              <div
                v-if="historyLoadError"
                :class="['flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs', displayIsDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
              >
                <span>{{ historyLoadError }}</span>
                <button
                  type="button"
                  @click="handleRetryLoadMoreHistory"
                  :class="['px-2.5 py-1 rounded-lg border text-xs font-medium transition cursor-pointer shrink-0', displayIsDark ? 'border-red-800 text-red-300 hover:bg-red-900/30' : 'border-red-300 text-red-600 hover:bg-red-100']"
                >
                  重试
                </button>
              </div>

              <!-- 子会话消息加载失败：可见失败态 + 重试（区别于「确实为空」） -->
              <div
                v-if="subMessagesError"
                :class="['flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs', displayIsDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
              >
                <span>{{ subMessagesError }}</span>
                <button
                  type="button"
                  @click="handleRetrySubSessionMessages"
                  :class="['px-2.5 py-1 rounded-lg border text-xs font-medium transition cursor-pointer shrink-0', displayIsDark ? 'border-red-800 text-red-300 hover:bg-red-900/30' : 'border-red-300 text-red-600 hover:bg-red-100']"
                >
                  重试
                </button>
              </div>

              <!-- 子会话确无真实消息：如实展示「暂无消息」（不再用合成假对话填充） -->
              <div
                v-if="activeViewingSubSession && !isLoadingCurrentSession && !isLoadingSubMessages && !subMessagesError && displayedMessages.length === 0"
                class="text-center text-xs text-gray-400 py-16 select-none"
              >
                暂无消息
              </div>

              <!-- 会话消息首次加载中动画 -->
              <div v-if="isLoadingCurrentSession || isLoadingSubMessages" class="flex flex-col items-center justify-center py-20 text-xs text-gray-400 gap-3 select-none">
                <svg class="animate-spin h-6 w-6 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span class="tracking-wide">{{ isLoadingSubMessages ? '正在加载子代理会话历史...' : '正在加载对话历史...' }}</span>
              </div>

              <ChatMessageItem
                v-else
                v-for="(msg, idx) in displayedMessages"
                :key="msg.id"
                :message="msg"
                :subSessions="currentActiveSession?.subSessions"
                :sessionId="currentActiveSession?.id"
                :isDark="displayIsDark"
                :sessionTokenInfo="currentDisplayTokenInfo"
                :isLastAssistant="idx === lastAssistantIndex"
                :isSending="isSending"
                @switchBranch="(msgId, branchIdx) => emit('switchBranch', msgId, branchIdx)"
                @editMessage="(msgId, text) => emit('editMessage', msgId, text)"
                @selectSubSession="handleSelectSubSessionOption"
                @humanResponse="handleHumanResponse"
                @resendMessage="handleResendMessage"
              />
            </div>
          </ScrollCursorLoader>

          <!-- 悬浮“回到底部” / “新内容” 提示按钮 -->
          <transition
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 translate-y-3 scale-95"
            enter-to-class="opacity-100 translate-y-0 scale-100"
            leave-active-class="transition-all duration-150 ease-in"
            leave-from-class="opacity-100 translate-y-0 scale-100"
            leave-to-class="opacity-0 translate-y-3 scale-95"
          >
            <div
              v-if="!isNearBottom && hasMessages"
              class="absolute bottom-4 right-6 z-20 pointer-events-auto"
            >
              <button
                type="button"
                @click="handleScrollToBottomClick"
                :class="[
                  'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg border backdrop-blur-md cursor-pointer transition-all hover:scale-105 active:scale-95 select-none',
                  displayIsDark
                    ? 'bg-[#182234]/90 border-[#2d3f5e] text-blue-300 hover:bg-[#1f2d45] shadow-black/40'
                    : 'bg-white/95 border-blue-200/80 text-blue-600 hover:bg-blue-50/80 shadow-blue-500/10'
                ]"
                title="回到底部"
              >
                <!-- 若正在流式输出中，显示动态微光波纹点 -->
                <span v-if="isSending" class="relative flex h-2 w-2">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                <span v-else class="flex items-center justify-center text-gray-400 dark:text-gray-300">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 14l-7 7m0 0l-7-7" />
                  </svg>
                </span>
                <span>{{ isSending ? '有新内容，回到底部' : '回到底部' }}</span>
              </button>
            </div>
          </transition>
        </div>

        <!-- 右侧：子 Agent 会话轨迹和标签面板 (位于图示红框位置) -->
        <SubAgentSidePanel
          v-if="availableSubSessionItems.length > 0"
          :items="availableSubSessionItems"
          :activeSubId="activeViewingSubSessionId"
          :isDark="displayIsDark"
          :isOpen="isSubPanelOpen"
          @selectOption="handleSelectSubSessionOption"
          @toggleOpen="isSubPanelOpen = !isSubPanelOpen"
        />

      </div>

      <!-- 顶部弹性占位（空会话时占 flex-1，与底部弹性占位对称，将中央内容推至绝对正中心；有消息时平滑缩为 0） -->
      <div
        class="transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden"
        :style="{
          flex: hasMessages ? '0 0 0px' : '1 1 0%'
        }"
      ></div>

      <!-- 中心聚合交互区：Hero 标题与大圆角输入框 -->
      <div class="w-full shrink-0 z-10 flex flex-col items-center">
    
        <div
          class="transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden flex flex-col items-center"
          :style="{
            maxHeight: hasMessages ? '0px' : '80px',
            opacity: hasMessages ? 0 : 1,
            transform: hasMessages ? 'translateY(-16px)' : 'translateY(0)',
            marginBottom: hasMessages ? '0px' : '8px'
          }"
        >
          <WelcomeView
            :isDark="displayIsDark"
            @selectPrompt="handleSelectPrompt"
          />
        </div>

        <!-- 子会话只读提示条：查看子代理历史时不展示主会话输入框，并引导快速切回 -->
        <div
          v-if="activeViewingSubSession"
          class="w-full max-w-3xl mx-auto px-4 py-3 mb-2"
        >
          <div :class="['px-4 py-3 rounded-2xl border flex items-center justify-between text-xs transition-colors shadow-xs', displayIsDark ? 'bg-[#151c2a] border-[#222d42] text-gray-300' : 'bg-blue-50/90 border-blue-200 text-blue-900']">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              <span>正在查看【{{ activeViewingSubSession.agentName }}】子会话历史（只读模式）</span>
            </div>
            <button
              @click="handleSelectSubSessionOption(null)"
              class="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium flex items-center gap-1.5 transition cursor-pointer shadow-xs"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span>返回主会话继续提问</span>
            </button>
          </div>
        </div>

        <!-- 大圆角输入框卡片：发送首条消息时随着底部占位缩起，平滑下沉吸底 -->
        <div
          v-else
          class="w-full transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          :style="{
            paddingBottom: hasMessages ? '16px' : '0px'
          }"
        >
          <ChatInputArea
            ref="inputAreaRef"
            :isSending="isSending"
            :isDark="displayIsDark"
            :models="displayModels"
            :selectedModelId="displaySelectedModel"
            :accessMode="displayAccessMode"
            :hasActiveSession="!!displayActiveId"
            :canChangeWorkspace="canChangeWorkspace"
            :workspaces="displayWorkspaces"
            :selectedWorkspaceId="displayActiveWorkspaceId"
            :selectedTeamId="localSelectedTeamId"
            :selectedAgentId="localSelectedAgentId"
            @sendMessage="handleSendMessage"
            @stopGeneration="handleStopGeneration"
            @updateModel="handleUpdateModel"
            @updateAccessMode="handleUpdateAccessMode"
            @updateTeam="(t) => localSelectedTeamId = t"
            @updateAgent="(a) => localSelectedAgentId = a"
            @openModelEditor="handleOpenModelEditor"
            @openTeamModal="handleOpenTeamModal"
            @selectWorkspace="handleSelectWorkspace"
            @newProject="handleOpenNewWorkspace"
            @quickStart="handleQuickStart"
            @clearCurrentSession="handleClearCurrentSession"
            @exportSession="handleExportSession"
            @openSettings="handleOpenSettings"
            @openSettingsTab="handleOpenSettingsTab"
          />
        </div>
      </div>

      <!-- 底部弹性占位（空会话时占 flex-1，使中央组绝对垂直居中；有消息时平滑收缩至 0，驱动输入框下沉） -->
      <div
        class="transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden"
        :style="{
          flex: hasMessages ? '0 0 0px' : '1.15 1 0%'
        }"
      ></div>

    </div>

    <!-- 设置悬浮框（Teleport 到 body，避免被 overflow/层叠上下文裁剪） -->
    <Teleport to="body">
      <SettingsModal
        v-if="isSettingsOpen"
        :isDark="displayIsDark"
        :initialTab="settingsInitialTab"
        @close="handleCloseSettings"
        @toggleTheme="handleToggleTheme"
        @clearSessions="handleClearSessions"
        @modelUpdated="handleModelUpdated"
      />

      <!-- 新建/编辑工作空间弹窗 -->
      <WorkspaceModal
        :isOpen="isWorkspaceModalOpen"
        :isDark="displayIsDark"
        @close="isWorkspaceModalOpen = false"
        @save="handleSaveWorkspace"
      />

      <!-- 新建/编辑团队弹窗 -->
      <TeamModal
        :isOpen="isTeamModalOpen"
        :isDark="displayIsDark"
        :models="displayModels"
        @close="isTeamModalOpen = false"
        @created="handleTeamCreated"
      />

      <!-- 主会话全部子代理会话概览抽屉 -->
      <SubSessionsOverviewDrawer
        :isOpen="isSubSessionsOverviewOpen"
        :subSessions="currentActiveSession?.subSessions || []"
        :isDark="displayIsDark"
        @close="isSubSessionsOverviewOpen = false"
        @selectSubSession="handleOpenSubSessionDetailFromOverview"
      />

      <!-- 子代理会话独立轨迹详情抽屉 -->
      <SubSessionDetailDrawer
        :isOpen="isSubSessionDetailOpen"
        :subSession="selectedSubSessionForDetail"
        :isDark="displayIsDark"
        @close="isSubSessionDetailOpen = false"
      />
    </Teleport>

  </div>
</template>

