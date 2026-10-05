<script setup lang="ts">
import { ref, provide } from 'vue';
import { useFilePreview } from '../../composables/useFilePreview';
import { FILE_PREVIEW_KEY } from '../../types/filePreview';
import FilePreviewPanel from '../../components/chat/FilePreviewPanel.vue';
import { useChatView, type ChatViewProps, type ChatViewEmits } from './useChatView';
import Sidebar from '../../components/chat/Sidebar.vue';
import WelcomeView from '../../components/chat/WelcomeView.vue';
import ChatMessageList from '../../components/chat/ChatMessageList.vue';
import ChatInputArea from '../../components/chat/ChatInputArea.vue';
import SettingsModal from '../settings/SettingsModal.vue';
import WorkspaceModal from '../../components/chat/WorkspaceModal.vue';
import TeamModal from '../../components/chat/TeamModal.vue';
import SubSessionsOverviewDrawer from '../../components/chat/SubSessionsOverviewDrawer.vue';
import SubSessionDetailDrawer from '../../components/chat/SubSessionDetailDrawer.vue';
import SubAgentSidePanel from '../../components/chat/SubAgentSidePanel.vue';

const props = defineProps<ChatViewProps>();
const emit = defineEmits<ChatViewEmits>();

const inputAreaRef = ref<InstanceType<typeof ChatInputArea> | null>(null);
const messagesContainerRef = ref<InstanceType<typeof ChatMessageList> | null>(null);
const { fileTabs, activeFileId, filePreviewOpen, openFilePreview, closeFileTab, refreshFile, runFileAction } = useFilePreview();
provide(FILE_PREVIEW_KEY, openFilePreview);

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
  reasoningEffort,
  reasoningEffortPending,
  reasoningEffortError,
  displayIsDark,
  currentActiveSession,
  displayedMessages,
  contextUsageIndicator,
  hasMessages,
  sendFailureNotice,
  dismissSendFailure,
  lastAssistantIndex,
  isNearBottom,
  isLoadingMoreHistory,
  historyLoadError,
  isLoadingCurrentSession,
  sessionLoadError,
  initLoadError,
  messageTurnMap,
  activeSubSessionTurnMap,
  activeSubSessionMessages,
  activeViewingSubSessionVO,
  hasMoreSubMessages,
  isLoadingMoreSubMessages,
  handleLoadMoreSubSessionHistory,
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
  handleUpdateTeam,
  handleOpenModels,
  handleOpenModelEditor,
  handleUpdateModel,
  handleUpdateAccessMode,
  handleUpdateReasoningEffort,
  handleOpenSettings,
  handleOpenSettingsTab,
  handleCloseSettings,
  handleModelUpdated,
  handleToggleTheme,
  handleSendMessage,
  handleStopGeneration,
  handleResendMessage,
  handleEditMessage,
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

    <!-- 全局纯净背景层 (Vue Bits 纯黑科技质感 + 极微弱环境微光) -->
    <div class="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div :class="displayIsDark ? 'absolute inset-0 bg-black' : 'absolute inset-0 bg-white'"></div>
      <div
        v-if="displayIsDark"
        class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[360px] bg-gradient-to-b from-blue-500/[0.035] via-indigo-500/[0.015] to-transparent blur-3xl pointer-events-none"
      ></div>
    </div>


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

    <!-- 主对话聊天视窗区域 (包含左侧根会话区域 + 右侧子会话面板) -->
    <div class="relative z-10 flex-1 flex h-full overflow-hidden">

      <!-- 左侧：根会话工作区 (包含消息列表与底部输入框，被右侧子代理面板向左挤压) -->
      <div class="relative flex-1 min-w-0 h-full flex flex-col overflow-hidden">

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

        <!-- 消息区与悬浮吸底控制容器 -->
        <div
          class="relative flex-1 min-w-0 flex flex-col overflow-hidden transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          :style="{
            flex: hasMessages ? '1 1 0%' : '0 0 0px',
            opacity: hasMessages ? 1 : 0,
            pointerEvents: hasMessages ? 'auto' : 'none'
          }"
        >
          <ChatMessageList
            ref="messagesContainerRef"
            :messages="displayedMessages"
            :turnMap="messageTurnMap"
            :sessionId="currentActiveSession?.id"
            :subSessions="currentActiveSession?.subSessions"
            :isDark="displayIsDark"
            :isSending="isSending"
            :isLoading="isLoadingCurrentSession"
            :historyLoadError="historyLoadError"
            :hasMore="!isLoadingCurrentSession && !!currentActiveSession?.hasMoreMessages"
            :isLoadingMore="isLoadingMoreHistory"
            :lastAssistantIndex="lastAssistantIndex"
            @load="handleLoadMoreHistory"
            @retryHistoryLoad="handleRetryLoadMoreHistory"
            @scroll="handleMessagesScroll"
            @wheel.passive="handleMessagesWheel"
            @touchstart.passive="handleTouchStart"
            @touchmove.passive="handleTouchMove"
            @switchBranch="(msgId, branchIdx) => emit('switchBranch', msgId, branchIdx)"
            @editMessage="handleEditMessage"
            @selectSubSession="handleSelectSubSessionOption"
            @humanResponse="handleHumanResponse"
            @resendMessage="handleResendMessage"
          />

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
                    ? 'bg-zinc-900/90 border-white/10 text-zinc-200 hover:bg-zinc-850 shadow-black/50 hover:text-white'
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

          <!-- 发送失败横幅：受理失败没有落库轮次，作为独立界面状态提示，不属于任何回答组 -->
          <div
            v-if="sendFailureNotice"
            class="w-full shrink-0 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-500 dark:text-red-400 flex items-start gap-3"
            role="alert"
          >
            <span class="flex-1">{{ sendFailureNotice.message }}</span>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-1 text-xs opacity-70 hover:opacity-100 transition-opacity"
              @click="dismissSendFailure"
            >
              知道了
            </button>
          </div>

          <!-- 大圆角输入框卡片：发送首条消息时随着底部占位缩起，平滑下沉吸底 -->
          <div
            class="w-full transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
            :style="{
              paddingBottom: hasMessages ? '16px' : '0px'
            }"
          >
            <ChatInputArea
              ref="inputAreaRef"
              :isSending="isSending"
              :isDark="displayIsDark"
              :contextUsage="contextUsageIndicator"
              :models="displayModels"
              :selectedModelId="displaySelectedModel"
              :accessMode="displayAccessMode"
              :reasoningEffort="reasoningEffort"
              :reasoningEffortPending="reasoningEffortPending"
              :reasoningEffortError="reasoningEffortError"
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
              @updateReasoningEffort="handleUpdateReasoningEffort"
              @updateTeam="handleUpdateTeam"
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

      <FilePreviewPanel
        v-if="fileTabs.length"
        v-show="filePreviewOpen"
        :tabs="fileTabs"
        :activeId="activeFileId"
        :isDark="displayIsDark"
        @activate="activeFileId = $event"
        @closeTab="closeFileTab"
        @close="filePreviewOpen = false"
        @refresh="refreshFile"
        @open="runFileAction('open')"
        @reveal="runFileAction('reveal')"
      />

      <button v-if="fileTabs.length && !filePreviewOpen" type="button" class="absolute right-4 top-3 z-30 rounded-lg border border-zinc-400/20 bg-white px-3 py-1.5 text-xs shadow-sm dark:bg-zinc-900" @click="filePreviewOpen = true">文件预览 · {{ fileTabs.length }}</button>

      <!-- 右侧：子 Agent 会话轨迹和标签面板 -->
      <SubAgentSidePanel
        v-if="availableSubSessionItems.length > 0 && !filePreviewOpen"
        :items="availableSubSessionItems"
        :activeSubId="activeViewingSubSessionId"
        :activeSubSession="activeViewingSubSessionVO"
        :subMessages="activeSubSessionMessages"
        :turnMap="activeSubSessionTurnMap"
        :isLoadingMessages="isLoadingSubMessages"
        :messagesError="subMessagesError"
        :hasMoreSubMessages="hasMoreSubMessages"
        :isLoadingMoreSubMessages="isLoadingMoreSubMessages"
        :isDark="displayIsDark"
        :isOpen="isSubPanelOpen"
        @selectOption="handleSelectSubSessionOption"
        @toggleOpen="isSubPanelOpen = !isSubPanelOpen"
        @retryMessages="handleRetrySubSessionMessages"
        @loadMoreMessages="handleLoadMoreSubSessionHistory"
      />

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

