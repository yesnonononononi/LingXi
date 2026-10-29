
<template>
  <div :class="['relative flex h-screen w-screen overflow-hidden font-sans', displayIsDark ? 'text-zinc-100 dark' : 'text-zinc-900 light']">

    <!-- 全局纯净背景层：已抽成可被插件替换的独立组件，明暗由 tokens.css 的变量自行切换 -->
    <ChatBackground />


    <Sidebar
      :sessions="localSessions"
      :activeSessionId="localActiveId"
      :workspaces="localWorkspaces"
      :activeWorkspaceId="localActiveWorkspaceId"
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

        <!-- 文件预览入口：必须挂**在消息区容器内**做绝对定位。挂到右侧同级容器上时会按整个容器
             右缘对齐，而子代理面板可见时那个右缘属于面板本身 —— 按钮就会盖住面板头部的「收起」。 -->
        <button v-if="fileTabs.length && !filePreviewOpen" type="button" class="absolute right-4 top-3 z-30 rounded-lg border border-zinc-400/20 bg-white px-3 py-1.5 text-xs shadow-sm dark:bg-zinc-900" @click="filePreviewOpen = true">{{ t('chat.view.filePreview', { count: fileTabs.length }) }}</button>

        <!-- 初始化数据加载失败：可见失败态（区别于「确实为空」，避免后端宕机时静默显示为空） -->
        <div
          v-if="initLoadError"
          :class="['px-4 py-2 border-b shrink-0 flex items-center text-xs', displayIsDark ? 'bg-red-950/40 border-red-900/60 text-red-300' : 'bg-red-50 border-red-200 text-red-600']"
        >
          <span>{{ initLoadError }}</span>
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
            {{ t('common.retry') }}
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
            :allowResend="executionControls.canResend.value"
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
            @selectSubSession="handleSelectSubSessionOption"
            @resendUnsent="handleResendUnsent"
            @editResend="executionControls.edit"
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
                    ? 'bg-zinc-900/90 border-white/10 text-zinc-200 hover:bg-zinc-800 shadow-black/50 hover:text-white'
                    : 'bg-white/95 border-blue-200/80 text-blue-600 hover:bg-blue-50/80 shadow-blue-500/10'
                ]"
                :title="t('chat.message.backToBottom')"
              >
                <!-- 若正在流式输出中，显示动态微光波纹点 -->
                <span v-if="isSending" class="relative flex h-2 w-2">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                <span v-else class="flex items-center justify-center text-zinc-400 dark:text-zinc-300">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 14l-7 7m0 0l-7-7" />
                  </svg>
                </span>
                <span>{{ isSending ? t('chat.message.newContentBackToBottom') : t('chat.message.backToBottom') }}</span>
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
            <!-- 文件预览要拿 sessionId 去解析工作区，新建会话受理失败时还没有会话，这个入口就别给了 -->
            <button
              v-if="sendFailureNotice.sessionId"
              type="button"
              class="shrink-0 rounded-md px-2 py-1 text-xs underline decoration-dotted underline-offset-2 opacity-80 hover:opacity-100 transition-opacity"
              @click="openErrorLog"
            >
              {{ logOpening ? t('chat.view.logOpening') : t('chat.view.openErrorLog') }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-1 text-xs opacity-70 hover:opacity-100 transition-opacity"
              @click="dismissSendFailure"
            >
                            {{ t('common.gotIt') }}
            </button>
          </div>

          <SessionConnectionNotice :state="streamHealthState" @reconnect="handleReconnectStream" />
          <ChatExecutionControls
            :status="currentActiveSession?.runStatus"
            :canResume="executionControls.canResume.value" :resuming="executionControls.isResuming.value"
            :hasUnresolved="executionControls.hasUnresolved.value" :error="executionControls.error.value"
            v-model:supplementDraft="executionControls.supplementDraft.value"
            v-model:supplementOpen="executionControls.supplementOpen.value"
            @resume="executionControls.resume"
          />
          <TaskProgressDock :background="backgroundTasks" :checklist="checklist" :isDark="displayIsDark"
            :executing="currentActiveSession?.runStatus === 'RUNNING'" />
          <!-- 待审批/待回答卡片存在时整块让位：此时输入框必然是禁用态，留着它只是把卡片往下挤，
               用户真正的下一步动作在卡片里。v-show 而非 v-if —— 组件不卸载，已经敲了一半的草稿不会丢。 -->
          <div
            v-show="!executionControls.hasUnresolved.value"
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
              :models="localModels"
              :selectedModelId="selectedModelId"
              :accessMode="accessMode"
              :reasoningEffort="reasoningEffort"
              :reasoningEffortPending="reasoningEffortPending"
              :reasoningEffortError="reasoningEffortError"
              :hasActiveSession="!!localActiveId"
              :canChangeWorkspace="canChangeWorkspace"
              :workspaces="localWorkspaces"
              :selectedWorkspaceId="localActiveWorkspaceId"
              :selectedTeamId="localSelectedTeamId"
              :selectedAgentId="selectedAgentId"
              @sendMessage="handleSendMessage"
              @stopGeneration="handleStopGeneration"
              @updateModel="handleUpdateModel"
              @updateAccessMode="handleUpdateAccessMode"
              @updateReasoningEffort="handleUpdateReasoningEffort"
              @updateTeam="handleUpdateTeam"
              @updateAgent="handleUpdateAgent"
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

      <!-- 右侧：子 Agent 会话轨迹和标签面板 -->
      <SubAgentSidePanel
        v-if="availableSubSessionItems.length > 0 && !filePreviewOpen"
        :items="availableSubSessionItems"
        :activeSubId="activeViewingSubSessionId"
        :activeSubSession="activeViewingSubSessionVO"
        :taskProgress="subTaskProgress"
        :subMessages="activeSubSessionMessages"
        :turnMap="activeSubSessionTurnMap"
        :isLoadingMessages="isLoadingSubMessages"
        :messagesError="subMessagesError"
        :hasMoreSubMessages="hasMoreSubMessages"
        :isLoadingMoreSubMessages="isLoadingMoreSubMessages"
        :streamHealthState="streamHealthState"
        @reconnect="handleReconnectStream"
        :isDark="displayIsDark"
        :isOpen="isSubPanelOpen"
        @selectOption="handleSelectSubSessionOption"
        @toggleOpen="isSubPanelOpen = !isSubPanelOpen"
        @retryMessages="handleRetrySubSessionMessages"
        @loadMoreMessages="handleLoadMoreSubSessionHistory"
      />

    </div>

    <!-- 设置悬浮框（Teleport 到 body，避免被 overflow/层叠上下文裁剪） -->
    <ChatResendDialog
      :open="!!executionControls.editTarget.value" v-model="executionControls.draft.value"
      :busy="executionControls.resending.value" :error="executionControls.error.value"
      :imageCount="executionControls.editTarget.value?.imageUrls?.length ?? (executionControls.editTarget.value?.imageUrl ? 1 : 0)"
      @cancel="executionControls.cancelEdit" @submit="executionControls.resend"
    />
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
        :models="localModels"
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
        :streamHealthState="streamHealthState"
        @reconnect="handleReconnectStream"
        :isDark="displayIsDark"
        @close="isSubSessionDetailOpen = false"
      />
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import { ref, provide, onMounted, shallowReactive, watch } from 'vue';
import { t } from '../../i18n';
import { isOk } from '../../utils/api';
import { LogAPI } from '../../services/log';
import { useFilePreview } from '../../composables/useFilePreview';
import { provideChatInputFocus } from '../../composables/useChatInputFocus';
import { FILE_PREVIEW_KEY } from '../../types/filePreview';
import { DECIDE_TOOL_CALL_KEY, ANSWER_CHOICES_KEY } from '../../types/toolDecision';
import { CHAT_MESSAGE_SLOTS_KEY } from '../../types/chatMessageSlots';
import MessageBodyDefault from '../../components/chat/MessageBodyDefault.vue';
import ChatBackground from '../../components/chat/ChatBackground.vue';
import TokenBackground from '../../components/background/TokenBackground.vue';
import ImageBackground from '../../components/background/ImageBackground.vue';
import { BACKGROUND_SLOTS_KEY } from '../../types/backgroundSlots';
import { useBackgroundPreference } from '../../composables/useBackgroundPreference';
import MessageActionsBar from '../../components/chat/MessageActionsBar.vue';
import { CHAT_INPUT_SLOTS_KEY } from '../../types/chatInputSlots';
import ChatInputContextUsage from '../../components/chat/ChatInputContextUsage.vue';
import ChatInputModelSelector from '../../components/chat/ChatInputModelSelector.vue';
import ChatInputSendButton from '../../components/chat/ChatInputSendButton.vue';
import FilePreviewPanel from '../../components/chat/FilePreviewPanel.vue';
import { useChatView } from './useChatView';
import Sidebar from '../../components/chat/Sidebar.vue';
import type { Component } from 'vue';
import { SIDEBAR_SLOTS_KEY } from '../../types/sidebarSlots';
import type { SidebarTreeSlotProps } from '../../types/sidebarSlots';
import SidebarWorkspaceTree from '../../components/chat/SidebarWorkspaceTree.vue';
import SidebarFooterBar from '../../components/chat/SidebarFooterBar.vue';
import WelcomeView from '../../components/chat/WelcomeView.vue';
import ChatMessageList from '../../components/chat/ChatMessageList.vue';
import ChatInputArea from '../../components/chat/ChatInputArea.vue';
// 命令面契约：inputAreaRef 只按这 11 项命令使用，不再用 InstanceType 绑组件内部形状（B-5 阶段 1a）
import type { ChatInputCommands } from '../../types/chatInputCommands';
import { assertChatInputCommands } from '../../utils/assertChatInputCommands';
import ChatExecutionControls from '../../components/chat/ChatExecutionControls.vue';
import TaskProgressDock from '../../components/chat/TaskProgressDock.vue';
import ChatResendDialog from '../../components/chat/ChatResendDialog.vue';
import SettingsModal from '../settings/SettingsModal.vue';
import WorkspaceModal from '../../components/chat/WorkspaceModal.vue';
import TeamModal from '../../components/chat/TeamModal.vue';
import SubSessionsOverviewDrawer from '../../components/chat/SubSessionsOverviewDrawer.vue';
import SubSessionDetailDrawer from '../../components/chat/SubSessionDetailDrawer.vue';
import SessionConnectionNotice from '../../components/chat/SessionConnectionNotice.vue';
import SubAgentSidePanel from '../../components/chat/SubAgentSidePanel.vue';

const inputAreaRef = ref<ChatInputCommands | null>(null);
/**
 * 「去聊天里说」能力注入：PlanCard 等深层卡片消费 CHAT_INPUT_FOCUS_KEY 取用本回调。
 *
 * <p>链路 ChatView → ChatMessageList → ChatMessageItem → PromptCard → PlanCard 是纯渲染祖先链，
 * 因此在此处 provide 即可被卡片 inject 到。反射取 `focusInput`（ChatInputArea 的 defineExpose），
 * 用可选链兜住「输入框尚未挂载 / 已卸载」的窗口期，避免点击时机竞态抛错。</p>
 */
provideChatInputFocus(() => inputAreaRef.value?.focusInput?.());

/**
 * dev 期命令面自检：确认 ChatInputArea 的 defineExpose 与 `ChatInputCommands` 契约一致。
 *
 * <p>为什么放在 `onMounted`：`inputAreaRef` 只有在子组件挂载后才有值，早于 `onMounted`
 * 永远是 null（会得到一条无意义的"目标为空"告警）。只在 DEV 执行，生产零开销。</p>
 */
onMounted(() => {
  assertChatInputCommands(inputAreaRef.value, 'ChatView.onMounted');
});
const messagesContainerRef = ref<InstanceType<typeof ChatMessageList> | null>(null);
const { fileTabs, activeFileId, filePreviewOpen, openFilePreview, closeFileTab, refreshFile, runFileAction } = useFilePreview();
provide(FILE_PREVIEW_KEY, openFilePreview);

const logOpening = ref(false);

/**
 * 在文件预览面板里打开 WARN/ERROR 日志。
 *
 * <p>日志位置由后端进程自己报告（<code>/log/location</code>），前端不自行拼接 —— 桌面端可能复用一个
 * 已在跑的实例，那种实例的日志目录不是本次启动器算出来的。失败横幅的 sessionId 就是本轮受理的会话，
 * 文件预览需要拿它去解析工作区，所以横幅没给出会话时这个入口不显示。</p>
 */
const openErrorLog = async (): Promise<void> => {
  const sessionId = sendFailureNotice.value?.sessionId;
  if (!sessionId || logOpening.value) return;
  logOpening.value = true;
  try {
    const result = await LogAPI.location();
    if (!isOk(result.code) || !result.data?.warnError) return;
    openFilePreview(sessionId, result.data.warnError);
  } finally {
    logOpening.value = false;
  }
};

const {
  isSidebarCollapsed,
  isSettingsOpen,
  settingsInitialTab,
  isSending,
  localSelectedTeamId,
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
  localSessions,
  localActiveId,
  localModels,
  localWorkspaces,
  localActiveWorkspaceId,
  selectedModelId,
  accessMode,
  selectedAgentId,
  handleResendUnsent,
  executionControls,
  backgroundTasks,
  checklist,
  subTaskProgress,
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
  streamHealthState,
  handleReconnectStream,
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
  handleUpdateAgent,
  handleUpdateReasoningEffort,
  handleOpenSettings,
  handleOpenSettingsTab,
  handleCloseSettings,
  handleModelUpdated,
  handleToggleTheme,
  handleSendMessage,
  handleStopGeneration,
  decideToolCall,
  answerChoices,
  handleSelectPrompt,
  handleQuickStart,
  handleLoadMoreHistory,
  handleRetryLoadMoreHistory,
  handleRetrySessionLoad,
  handleRetrySubSessionMessages,
  handleSelectSubSessionOption,
  handleOpenSubSessionDetailFromOverview,
  handleScrollToBottomClick,
  handleMessagesScroll,
  handleMessagesWheel,
  handleTouchStart,
  handleTouchMove,
} = useChatView({ inputAreaRef, messagesContainerRef });

// 卡片决策提交能力：注入给深层卡片组件（PlanCard / ApprovalCard / RequireChoiceCard）
provide(DECIDE_TOOL_CALL_KEY, decideToolCall);
provide(ANSWER_CHOICES_KEY, answerChoices);

// 默认实现也走注册入口，保证生产与扩展组件使用同一契约。
provide(CHAT_MESSAGE_SLOTS_KEY, { body: MessageBodyDefault, actions: MessageActionsBar });

/**
 * 主页背景装饰表面（L2 切片：本仓第一个**真实替换实现**的注册点，全仓唯一）。
 *
 * <p>没有背景时注册的就是内置令牌背景本身 —— 「宿主注入」因此是生产活路径，
 * 而「未注册兜底」由无宿主挂载场景（visual 组件场景直接挂 ChatBackground）承担，
 * 两条分支都真实存在，且只有一份实现代码，不存在 A/B 双实现漂移。</p>
 *
 * <p>用 shallowReactive 而不是常量对象：用户在设置页选图/清除后表面要立刻跟着换
 * （图片变量本身是实时的，若表面不换就会出现「有图没遮罩」）。组件对象不该被深度代理，
 * 所以刻意用 shallow 版本。</p>
 */
const { hasBackground: hasBackgroundImage } = useBackgroundPreference();
const backgroundSlots = shallowReactive<{ surface: Component }>({
  surface: hasBackgroundImage.value ? ImageBackground : TokenBackground,
});
watch(hasBackgroundImage, (hasBackground) => {
  backgroundSlots.surface = hasBackground ? ImageBackground : TokenBackground;
});
provide(BACKGROUND_SLOTS_KEY, backgroundSlots);

/**
 * 输入区插槽渲染器（同上：试点期注册的就是**内置默认实现**本身）。
 *
 * <p>三个字段全部指向默认实现，好处是「宿主注入」这条分支在生产是活路径，
 * 而「未注册」的兜底分支由无宿主挂载场景（visual 场景直接挂 ChatInputArea）承担，
 * 两条分支都真实存在，且只有一份实现代码 —— 不存在 A/B 双实现漂移。
 * 注意这里**只注册渲染器**：输入/附件/语音/菜单/拖拽等行为状态仍全部留在 ChatInputArea 内部。</p>
 */
provide(CHAT_INPUT_SLOTS_KEY, {
  contextUsage: ChatInputContextUsage,
  modelSelector: ChatInputModelSelector,
  sendButton: ChatInputSendButton,
});

/**
 * Sidebar 插槽渲染器（B 档第三组件 S4：让「宿主注入」这条分支成为活路径）。
 *
 * <p>注册的就是**内置默认实现**本身：生产里走<em>注入分支</em>，而无宿主挂载场景
 * （例如 visual 组件场景直接挂 Sidebar）走<em>兜底分支</em>，两条分支都真实存在，
 * 且只有一份实现代码 —— 不存在 A/B 双实现漂移。</p>
 *
 * <p>Sidebar 的对外契约只有 2 个插槽，且**不含** openModels / toggleTheme 两个死事件
 * （已裁决不纳入契约，另立缺陷 D-1），因此这里只注册两个字段。</p>
 */
/**
 * 默认工作区树实现的注册标记。
 *
 * <p>它的 props 是**内部接口**（24 项，见 SidebarWorkspaceTree.vue 文件头），并不满足对外 7 项
 * 契约，因此注册处必须显式转换 —— 这是设计 §7.0「两套接口」方案③的直接代价。</p>
 *
 * <p><b>为什么这个转换是安全的：</b>Sidebar 用组件身份（`injectedTree === SidebarWorkspaceTree`）
 * 决定渲染时喂哪一套 props；命中默认实现时喂内部 props，绝不会按对外契约喂它。
 * 真正的第三方替换实现走的是对外契约分支，与这里无关。</p>
 */
const defaultWorkspaceTree = SidebarWorkspaceTree as unknown as Component<SidebarTreeSlotProps>;

provide(SIDEBAR_SLOTS_KEY, {
  workspaceTree: defaultWorkspaceTree,
  sidebarFooter: SidebarFooterBar,
});
</script>
