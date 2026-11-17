
<template>
  <div :class="['relative flex h-screen w-screen overflow-hidden font-sans', displayIsDark ? 'text-zinc-100 dark' : 'text-zinc-900 light']">

    <!-- 全局纯净背景层：已抽成可被插件替换的独立组件，明暗由 tokens.css 的变量自行切换 -->
    <ChatBackground />


    <Sidebar
      :sessions="localSessions"
      :activeSessionId="localActiveId"
      :activeSubSessionId="isSubPanelOpen && !previewPanelVisible ? activeViewingSubSessionId : null"
      :workspaces="localWorkspaces"
      :activeWorkspaceId="localActiveWorkspaceId"
      :isCollapsed="isSidebarCollapsed"
      :isDark="displayIsDark"
      @selectSession="handleSidebarSessionSelect"
      @newSession="handleNewSession"
      @deleteSession="handleDeleteSession"
      @renameSession="handleRenameSession"
      @togglePin="handleTogglePin"
      @selectWorkspace="handleSelectWorkspace"
      @newWorkspace="handleOpenNewWorkspace"
      @deleteWorkspace="handleDeleteWorkspace"
      @toggleCollapse="isSidebarCollapsed = !isSidebarCollapsed"
      @openSettings="handleOpenSettings"
      @openModels="handleOpenModels"
      @toggleTheme="handleToggleTheme"
    />

    <!-- 主对话聊天视窗区域 (包含左侧根会话区域 + 右侧子会话面板) -->
    <div class="relative z-10 flex-1 min-w-0 flex h-full overflow-hidden">

      <!-- 左侧：根会话工作区 (包含消息列表与底部输入框，被右侧子代理面板向左挤压) -->
      <div class="relative flex-1 min-w-0 h-full flex flex-col overflow-hidden">

        <!-- 顶部横条：左会话名、右预览类入口。整条在流内占高，不再盖在消息上；
             入口挂在本列内，右缘就不会跑到子代理面板头上（那会盖住面板头部的「收起」）。
             横条**常驻**：预览面板开合只改右侧列宽，横条若跟着消失/出现，消息区高度会跳 44px。
             有文件标签时出现「文件预览」，页面预览入口始终在（零文件标签也能进）。 -->
        <header
          data-test="chat-header-bar"
          :class="['shrink-0 flex h-11 items-center justify-between gap-3 px-4 border-b', displayIsDark ? 'border-zinc-800/70' : 'border-zinc-200/70']"
        >
          <!-- 会话标题：双击就地重命名（Enter / 失焦提交，Esc 取消），只有已入库会话可改 -->
          <input
            v-if="isHeaderTitleEditing"
            ref="headerTitleInputRef"
            v-model="headerTitleDraft"
            data-test="chat-title-input"
            class="min-w-0 flex-1 bg-transparent border-b border-blue-500/70 px-0.5 text-sm font-medium outline-none"
            @blur="commitHeaderTitleRename"
            @keydown="handleHeaderTitleKeydown"
          />
          <h1
            v-else
            data-test="chat-title"
            :class="['min-w-0 flex-1 truncate text-sm font-medium', canRenameHeaderTitle ? 'cursor-text' : '']"
            :title="headerTitleTooltip"
            @dblclick="startHeaderTitleRename"
          >{{ headerSessionName }}</h1>
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              data-test="chat-preview-toggle"
              :aria-label="t('filePreview.togglePanel')"
              :title="togglePreviewPanelTitle"
              :aria-pressed="previewPanelVisible"
              :class="[
                'inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors cursor-pointer',
                previewPanelVisible
                  ? 'bg-zinc-200/80 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/90'
              ]"
              @click="togglePreviewPanel"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <line x1="15" y1="4" x2="15" y2="20" />
              </svg>
            </button>
            <!-- 用量审计入口：与上面两个入口并排。面板是绝对定位抽屉，故入口始终留在入口行里，
                 收起后由它重新打开（面板自带的「收起」按钮只负责关）。 -->
            <button
              v-if="currentActiveSession?.id != null"
              type="button"
              data-test="token-audit-entry"
              :aria-label="t('chat.tokenAudit.open')"
              :title="t('chat.tokenAudit.open')"
              :aria-expanded="isTokenAuditOpen"
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              :class="isTokenAuditOpen ? 'bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/90'"
              @click="isTokenAuditOpen = !isTokenAuditOpen"
            >
              <svg class="w-3.5 h-3.5 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.5 6a7.5 7.5 0 1 0 7.5 7.5h-7.5V6Z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13.5 10.5H21A7.5 7.5 0 0 0 13.5 3v7.5Z" />
              </svg>
              <span>{{ t('chat.tokenAudit.title') }}</span>
            </button>
          </div>
        </header>

        <!-- 用量审计浮动面板：贴在消息区容器内做绝对定位（与顶部横条同一坐标系），
             偏移 top-12 是为了落在横条下方不盖住入口；高度由容器剩余空间约束，内部自行滚动。 -->
        <TokenAuditPanel
          v-if="currentActiveSession?.id != null"
          v-model:open="isTokenAuditOpen"
          :sessionId="currentActiveSession.id"
          :executing="currentActiveSession.runStatus === 'RUNNING'"
        />

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
            :dockPendingInteractionCards="true"
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
          <Transition name="pending-queue">
            <div
              v-if="pendingQueue.snapshot.value?.entries.length"
              class="pending-queue-dock w-full max-w-lx-chat mx-auto px-4 mb-2.5"
              data-testid="pending-chat-queue"
            >
              <component
                :is="resolvedPendingQueuePanel"
                :pending-queue="pendingQueue"
                :is-dark="displayIsDark"
                @edit="handlePendingEdit"
                @restore="handlePendingRestore"
              />
            </div>
          </Transition>
          <PendingInteractionDock
            :entries="dockedPendingInteractions.entries"
            :tool-calls="dockedPendingInteractions.toolCalls"
            :session-id="currentActiveSession?.id"
            :is-dark="displayIsDark"
          />
          <div
            class="w-full transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
            :style="{
              paddingBottom: hasMessages ? '16px' : '0px'
            }"
          >
            <div
              v-if="editingPending"
              data-testid="pending-edit-banner"
              class="mx-auto mb-2 flex w-full max-w-lx-chat items-center justify-between gap-3 rounded-xl border px-4 py-1.5 text-xs"
              :class="displayIsDark
                ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                : 'border-amber-300/70 bg-amber-50 text-amber-700'"
            >
              <span class="min-w-0 truncate">{{ t('chat.pending.editing') }}</span>
              <button
                type="button"
                data-testid="pending-edit-cancel"
                class="shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-medium hover:underline"
                @click="cancelQueuedEdit"
              >{{ t('chat.pending.cancelEdit') }}</button>
            </div>
            <ChatInputArea
              ref="inputAreaRef"
              :isSending="isSending"
              :queueMessage="canQueueMessage ? handleQueueMessage : undefined"
              :updateQueuedMessage="editingPending ? handleUpdateQueuedMessage : undefined"
              :editingQueued="!!editingPending"
              :isDark="displayIsDark"
              :contextUsage="contextUsageIndicator"
              :models="localModels"
              :selectedModelId="selectedModelId"
              :accessMode="accessMode"
              :envType="envType"
              :reasoningEffort="reasoningEffort"
              :reasoningEffortPending="reasoningEffortPending"
              :reasoningEffortError="reasoningEffortError"
              :hasActiveSession="!!localActiveId"
              :canChangeWorkspace="canChangeWorkspace"
              :workspaces="localWorkspaces"
              :selectedWorkspaceId="localActiveWorkspaceId"
              :selectedTeamId="localSelectedTeamId"
              :selectedAgentId="selectedAgentId"
              :mode="chatMode"
              :prediction="instructionPrediction"
              @sendMessage="handleSendMessage"
              @stopGeneration="handleStopGeneration"
              @updateModel="handleUpdateModel"
              @updateReasoningEffort="handleUpdateReasoningEffort"
              @updateTeam="handleUpdateTeam"
              @updateAgent="handleUpdateAgent"
              @updateMode="handleUpdateMode"
              @applyPrediction="clearInstructionPrediction"
              @updateDraftEmpty="draftEmpty = $event"
              @openModelEditor="handleOpenModelEditor"
              @openTeamModal="handleOpenTeamModal"
              @selectWorkspace="handleSelectWorkspace"
              @newProject="handleOpenNewWorkspace"
              @quickStart="handleQuickStart"
              @clearCurrentSession="handleClearCurrentSession"
              @exportSession="handleExportSession"
              @openSettings="handleOpenSettings"
              @openSettingsTab="handleOpenSettingsTab"
              @updateAccessMode="handleUpdateAccessMode"
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
        v-if="panelMounted"
        :visible="previewPanelVisible"
        :default-maximized="true"
        :tabs="fileTabs"
        :activeId="activeFileId"
        :unifiedTabs="unifiedTabs"
        :activeTabKey="activeTabKey"
        :designTabs="designTabs"
        :planTabs="planTabs"
        :sessionId="localActiveId"
        :isDark="displayIsDark"
        @activate="activeFileId = $event"
        @closeTab="closeFileTab"
        @activateTab="activateTab"
        @closeUnifiedTab="closeUnifiedTab"
        @createNewTab="createNewTab"
        @newTabAction="handleNewTabAction"
        @close="closePreviewPanel"
        @refresh="refreshFile"
        @open="runFileAction('open')"
        @reveal="runFileAction('reveal')"
        @sendToChat="handleDesignSendToChat"
      />

      <!-- 右侧：子 Agent 会话轨迹和标签面板 -->
      <SubAgentSidePanel
        v-if="availableSubSessionItems.length > 0 && !previewPanelVisible"
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

      <!-- 内置浏览器 Show with Agent 交互弹窗 -->
      <ShowWithAgentModal
        :open="showWithAgentOpen"
        :payload="showWithAgentPayload"
        @close="showWithAgentOpen = false"
        @send="handleShowWithAgentSend"
        @insert="handleShowWithAgentInsert"
      />
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import type {Component} from 'vue';
import {computed, inject, onBeforeUnmount, onMounted, provide, ref, shallowReactive, watch} from 'vue';
import {t} from '../../i18n';
import {isOk} from '../../utils/api';
import {LogAPI} from '../../services/log';
import {useFilePreview} from '../../composables/useFilePreview';
import {useProjectPagePreview} from '../../composables/useProjectPagePreview';
import {useUnifiedPreviewTabs} from '../../composables/useUnifiedPreviewTabs';
import {useInlineRename} from '../../composables/useInlineRename';
import {isTempSessionId} from '../../utils/ids';
import {DEFAULT_WINDOW_TITLE, resolveWindowTitle} from '../../utils/windowTitle';
import {loadShortcutBindings, useGlobalShortcuts, useShortcuts} from '../../composables/useShortcuts';
import {provideChatInputFocus} from '../../composables/useChatInputFocus';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import type {ShowWithAgentPayload} from '../../types/projectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../types/projectPagePreview';
import {PLAN_PREVIEW_KEY} from '../../types/previewPanel';
import ShowWithAgentModal, {type ShowWithAgentSubmitData} from '../../components/chat/ShowWithAgentModal.vue';
import {composeMessageWithDocuments} from '../../utils/pastedDocument';
import {ANSWER_CHOICES_KEY, DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {CHAT_MESSAGE_SLOTS_KEY} from '../../types/chatMessageSlots';
import {INTERACTION_CARD_SLOTS_KEY} from '../../types/interactionCardSlots';
import ApprovalCard from '../../components/chat/ApprovalCard.vue';
import PlanCard from '../../components/chat/PlanCard.vue';
import ChoiceQuestionGroup from '../../components/chat/ChoiceQuestionGroup.vue';
import MessageBodyDefault from '../../components/chat/MessageBodyDefault.vue';
import ChatBackground from '../../components/chat/ChatBackground.vue';
import TokenBackground from '../../components/background/TokenBackground.vue';
import ImageBackground from '../../components/background/ImageBackground.vue';
import {BACKGROUND_SLOTS_KEY} from '../../types/backgroundSlots';
import {useBackgroundPreference} from '../../composables/useBackgroundPreference';
import {usePackHost} from '../../packs/packHost';
import MessageActionsBar from '../../components/chat/MessageActionsBar.vue';
import {CHAT_INPUT_SLOTS_KEY} from '../../types/chatInputSlots';
import ChatInputContextUsage from '../../components/chat/ChatInputContextUsage.vue';
import ChatInputModelSelector from '../../components/chat/ChatInputModelSelector.vue';
import ChatInputSendButton from '../../components/chat/ChatInputSendButton.vue';
import FilePreviewPanel from '../../components/chat/FilePreviewPanel.vue';
import {useChatView} from './useChatView';
import type {PendingAttachmentFile} from './usePendingChatQueue';
import {useInstructionPredict} from '../../composables/useInstructionPredict';
import {isCompletedTurnStatus} from '../../utils/turnStatus';
import {useUserConfigStore} from '../../stores/userConfigStore';
import Sidebar from '../../components/chat/Sidebar.vue';
import type {SidebarTreeSlotProps} from '../../types/sidebarSlots';
import {SIDEBAR_SLOTS_KEY} from '../../types/sidebarSlots';
import SidebarWorkspaceTree from '../../components/chat/SidebarWorkspaceTree.vue';
import SidebarFooterBar from '../../components/chat/SidebarFooterBar.vue';
import WelcomeView from '../../components/chat/WelcomeView.vue';
import ChatMessageList from '../../components/chat/ChatMessageList.vue';
import ChatInputArea from '../../components/chat/ChatInputArea.vue';
// 命令面契约：inputAreaRef 只按这 11 项命令使用，不再用 InstanceType 绑组件内部形状（B-5 阶段 1a）
import type {ChatInputCommands} from '../../types/chatInputCommands';
import type {ChatMode, PendingTaskEntry} from '../../types/chat';
import {assertChatInputCommands} from '../../utils/assertChatInputCommands';
import ChatExecutionControls from '../../components/chat/ChatExecutionControls.vue';
import TaskProgressDock from '../../components/chat/TaskProgressDock.vue';
import PendingChatQueuePanel from '../../components/chat/PendingChatQueuePanel.vue';
import PendingInteractionDock from '../../components/chat/PendingInteractionDock.vue';
import {collectDockedPendingInteractions} from '../../utils/promptCardGroups';
import ChatResendDialog from '../../components/chat/ChatResendDialog.vue';
import SettingsModal from '../settings/SettingsModal.vue';
import WorkspaceModal from '../../components/chat/WorkspaceModal.vue';
import TeamModal from '../../components/chat/TeamModal.vue';
import SubSessionsOverviewDrawer from '../../components/chat/SubSessionsOverviewDrawer.vue';
import SubSessionDetailDrawer from '../../components/chat/SubSessionDetailDrawer.vue';
import SessionConnectionNotice from '../../components/chat/SessionConnectionNotice.vue';
import SubAgentSidePanel from '../../components/chat/SubAgentSidePanel.vue';
import TokenAuditPanel from '../../components/chat/TokenAuditPanel.vue';

const inputAreaRef = ref<ChatInputCommands | null>(null);
/**
 * plan 模式的唯一事实源。
 *
 * <p>历史实现里 plan 模式是 ChatInputArea 的私有 ref，`updateMode` 事件发出去没有任何监听者
 * —— 宿主既观察不到也控制不了，回填文本还能顺手把它改掉。提到视图层之后，输入组件只通过
 * `mode` prop + `updateMode` 事件读写它，模式状态从此可观察、可控制、可被用例断言。</p>
 */
const chatMode = ref<ChatMode>('auto');
const handleUpdateMode = (mode: ChatMode) => {
  chatMode.value = mode === 'plan' ? 'plan' : 'auto';
};
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
const showWithAgentOpen = ref(false);
const showWithAgentPayload = ref<ShowWithAgentPayload | null>(null);

const handleShowWithAgentSend = (data: ShowWithAgentSubmitData) => {
  showWithAgentOpen.value = false;
  const finalText = data.htmlDocument
    ? composeMessageWithDocuments(data.text, [data.htmlDocument])
    : data.text;
  handleSendMessage(finalText, chatMode.value === 'plan', null, null, data.files);
};

const handleShowWithAgentInsert = (data: ShowWithAgentSubmitData) => {
  showWithAgentOpen.value = false;
  if (data.files.length > 0) {
    inputAreaRef.value?.setAttachedImages(data.files);
  }
  if (data.htmlDocument) {
    inputAreaRef.value?.addPastedDocument(data.htmlDocument.content, { title: data.htmlDocument.title });
  }
  inputAreaRef.value?.setInputText(data.text);
  inputAreaRef.value?.focusInput?.();
};

onMounted(() => {
  assertChatInputCommands(inputAreaRef.value, 'ChatView.onMounted');
  // 快捷键真源在后端个性化配置：先拉一次，读失败会回落默认值（任何功能都还能用）。
  void loadShortcutBindings();
  const offShowWithAgent = window.electronAPI?.projectPage?.onShowWithAgent?.((payload: ShowWithAgentPayload) => {
    showWithAgentPayload.value = payload;
    showWithAgentOpen.value = true;
  });
  if (offShowWithAgent) {
    onBeforeUnmount(offShowWithAgent);
  }
});
const messagesContainerRef = ref<InstanceType<typeof ChatMessageList> | null>(null);
const { fileTabs, activeFileId, filePreviewOpen, openFilePreview, closeFileTab, refreshFile, runFileAction } = useFilePreview();

/**
 * 预览面板的内容模式 + 项目页面预览状态。
 *
 * <p>优先继承应用根组件 {@code App.vue} 注入的全局浏览器实例，使已打开的网页不随
 * 会话切换或路由切换销毁；仅在独立挂载 {@code ChatView} 的场景下回退创建本地实例。</p>
 */
const pagePreview = inject(PROJECT_PAGE_PREVIEW_KEY, null) ?? useProjectPagePreview();
provide(PROJECT_PAGE_PREVIEW_KEY, pagePreview);

const {
  previewPanelOpen,
  panelMounted,
  unifiedTabs,
  activeTabKey,
  designTabs,
  planTabs,
  togglePreviewPanel,
  closePreviewPanel,
  createNewTab,
  activateTab,
  closeUnifiedTab,
  openFilePreviewInPanel,
  openPlanPreview,
  handleNewTabAction,
} = useUnifiedPreviewTabs({
  fileTabs,
  activeFileId,
  filePreviewOpen,
  openFilePreview,
  closeFileTab,
  pagePreview,
  sessions: () => localSessions.value,
  t,
});

const previewPanelVisible = computed<boolean>(() => previewPanelOpen.value);
/** 快捷键绑定的只读视图：设置页保存后即时生效，标题提示跟着一起变。 */
const shortcuts = useShortcuts();
const togglePreviewPanelTitle = computed<string>(() => {
  const shortcut = shortcuts.label('togglePreview', window.electronAPI?.platform);
  return `${t('filePreview.togglePanel')} (${shortcut})`;
});
/** 顶部横条左侧展示的会话名：空态（未建会话 / 待首次发送）给占位文案，不留一段空白。 */
const headerSessionName = computed<string>(() => currentActiveSession.value?.title?.trim() || t('chat.sidebar.newSession'));

provide(FILE_PREVIEW_KEY, openFilePreviewInPanel);
provide(PLAN_PREVIEW_KEY, openPlanPreview);

/** 将设计原型画布或实现计划生成的文本填入聊天输入区并聚焦。 */
const handleDesignSendToChat = (payload: { prompt: string }): void => {
  if (!payload.prompt?.trim()) return;
  inputAreaRef.value?.setInputText(payload.prompt);
  inputAreaRef.value?.focusInput?.();
};

/**
 * 撤销待发送消息：仅在后端成功移除后回写输入框并聚焦，避免原文被自动发出。
 *
 * <p>附件必须先取字节再撤销 —— 撤销会把磁盘上的附件一起删掉，顺序反了就只能回填出文字。</p>
 *
 * <p>「编辑」不走这里：编辑是原位更新（`PUT`），撤销才是「把这条拿回来当新消息」。</p>
 */
const handlePendingRestore = async (entry: PendingTaskEntry): Promise<void> => {
  const restored = await pendingQueue.attachmentFiles(entry);
  const cancelled = await pendingQueue.cancel(entry.id);
  if (!cancelled) return;
  editingPending.value = null;
  inputAreaRef.value?.setInputText(entry.input);
  if (restored.length) inputAreaRef.value?.setAttachedImages(restored.map(item => item.file));
  inputAreaRef.value?.focusInput?.();
};

/**
 * 正在原地编辑的那条待发送消息。
 *
 * <p>`restored` 保存「File 对象 ↔ 附件 id」的对应：提交时用**对象引用**判断用户还留着哪几张图，
 * 比按文件名匹配可靠（同名图会串），也不需要给 `File` 塞自定义字段。</p>
 */
const editingPending = ref<{id: string; restored: PendingAttachmentFile[]} | null>(null);

/**
 * 编辑：把这条的文本与图片回填到输入区，**不撤销**。
 *
 * <p>不撤销是这次改动的重点 —— 撤销会删掉磁盘附件，用户只要点发送就得把图重新传一遍；
 * 原位更新则是「同一行、同一批文件」。</p>
 */
const handlePendingEdit = async (entry: PendingTaskEntry): Promise<void> => {
  const restored = await pendingQueue.attachmentFiles(entry);
  editingPending.value = {id: entry.id, restored};
  inputAreaRef.value?.setInputText(entry.input);
  inputAreaRef.value?.setAttachedImages(restored.map(item => item.file));
  inputAreaRef.value?.focusInput?.();
};

/** 放弃编辑：队列里那条**原样留着**（没撤销过），输入区清空即可。 */
const cancelQueuedEdit = (): void => {
  editingPending.value = null;
  inputAreaRef.value?.setInputText('');
  inputAreaRef.value?.setAttachedImage(null);
};

/**
 * 编辑态提交：只改正文、被保留的图片与新增图片，外加模型 / 执行体 / 计划模式。
 *
 * <p>保留判定用**对象引用**（`images.includes(item.file)`）：输入区把回填进来的 `File`
 * 原样还回来，删掉的那张就不在列表里；按文件名匹配会被同名图串掉。</p>
 */
const handleUpdateQueuedMessage = async (text: string, requirePlan: boolean,
                                          _agentId: string | number | null | undefined,
                                          images: File[]): Promise<boolean> => {
  const editing = editingPending.value;
  if (!editing) return false;
  const keptIds = editing.restored.filter(item => images.includes(item.file)).map(item => item.id);
  const added = images.filter(image => !editing.restored.some(item => item.file === image));
  const updated = await submitPendingEdit(editing.id, text, requirePlan, keptIds, added);
  if (updated) editingPending.value = null;
  return updated;
};


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
    openFilePreviewInPanel({ sessionId, path: result.data.warnError });
  } finally {
    logOpening.value = false;
  }
};

const {
  isSidebarCollapsed,
  isSettingsOpen,
  settingsInitialTab,
  isSending,
  canQueueMessage,
  pendingQueue,
  handleQueueMessage,
  submitPendingEdit,
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
  envType,
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
  handleSelectSidebarSession,
  handleNewSession,
  handleDeleteSession,
  handleRenameSession,
  handleTogglePin,
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
  handleUpdateAgent,
  handleUpdateReasoningEffort,
  handleUpdateAccessMode,
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
} = useChatView({ inputAreaRef, messagesContainerRef, subSessionPanelVisible: computed(() => !previewPanelVisible.value) });

/** 被编辑的那条从队列消失（被派发 / 被别处撤销）时退出编辑态，别让输入框悬在一个不存在的目标上。 */
watch(() => pendingQueue.snapshot.value, snapshot => {
  const editing = editingPending.value;
  if (!editing || !snapshot) return;
  if (!snapshot.entries.some(entry => entry.id === editing.id)) editingPending.value = null;
});

/**
 * 窗口级快捷键分发：只把已有入口再调一次，不新增任何业务分支。
 *
 * <p>目标态全部读当前 ref，所以「设置页改完立即生效」不需要重新挂监听 —— 监听只挂一次，
 * 绑定表由 {@link useShortcuts} 的模块级真源提供。</p>
 */
useGlobalShortcuts(() => ({
  toggleSidebar: () => { isSidebarCollapsed.value = !isSidebarCollapsed.value; },
  togglePreview: togglePreviewPanel,
  // 设置页是「开关」语义：已经打开时按下应关闭，否则这个键永远只能开不能关。
  toggleSettings: () => { if (isSettingsOpen.value) handleCloseSettings(); else handleOpenSettings(); },
  newSession: () => { void handleNewSession(); },
}));

// 必须在 useChatView 初始化 currentActiveSession 之后再 immediate watch，否则会触发 TDZ 白屏。
watch(headerSessionName, (sessionName) => {
  if (typeof document !== 'undefined') {
    document.title = resolveWindowTitle(sessionName);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.title = DEFAULT_WINDOW_TITLE;
  }
});

/** 只有已入库会话能就地改名：临时会话（temp-*）后端没有这条记录，改了存不下。 */
const canRenameHeaderTitle = computed<boolean>(() => {
  const id = currentActiveSession.value?.id;
  return id != null && !isTempSessionId(String(id));
});

/** 标题悬停提示：可改名时补一句双击提示；不可改名时只显示全名（截断后仍能看全）。 */
const headerTitleTooltip = computed<string>(() =>
  canRenameHeaderTitle.value
    ? `${headerSessionName.value}\n${t('chat.view.renameHint')}`
    : headerSessionName.value
);

/** 标题输入框元素：模板用字符串 ref 绑定，交给 useInlineRename 聚焦并全选。 */
const headerTitleInputRef = ref<HTMLInputElement | null>(null);

/**
 * 顶部横条标题的就地重命名。
 *
 * <p>写入仍走 {@link handleRenameSession}（会话改名的唯一入口，改完即写回本地列表）；
 * 这里只持有编辑态。目标会话 id 在进入编辑那一刻锁定，编辑途中切会话不会把名字写到别人头上。</p>
 */
const {
  editing: isHeaderTitleEditing,
  draft: headerTitleDraft,
  start: startHeaderTitleRename,
  commitEdit: commitHeaderTitleRename,
  handleKeydown: handleHeaderTitleKeydown,
} = useInlineRename<string>({
  inputRef: headerTitleInputRef,
  canEdit: () => canRenameHeaderTitle.value,
  readValue: () => currentActiveSession.value?.title ?? '',
  readTarget: () => {
    const id = currentActiveSession.value?.id;
    return id == null ? null : String(id);
  },
  commit: (name: string, sessionId: string): void => {
    void handleRenameSession(sessionId, name);
  },
});

/** 配置真源（与 useChatView 同一个 store 实例）：这里只读指令预测模型是否配置。 */
const userConfig = useUserConfigStore();

/**
 * 指令预测：最后一轮的完成状态与轮次 id 全部取自后端下发的事实。
 *
 * <p>末轮 id 取「最后一条带 turnId 的消息」；是否生成由该轮 {@code turns[turnId].status}
 * 决定 —— 只有 COMPLETED 才算「正常完成」，失败/取消即便有终态正文也不预测。</p>
 */
const lastTurnId = computed<string | null>(() => {
  const messages = displayedMessages.value;
  for (let index = messages.length - 1; index >= 0; index--) {
    const turnId = messages[index]?.turnId;
    if (turnId) return String(turnId);
  }
  return null;
});

const lastTurnCompleted = computed<boolean>(() => {
  const turnId = lastTurnId.value;
  if (!turnId) return false;
  const turn = currentActiveSession.value?.turns?.[turnId];
  return turn != null && isCompletedTurnStatus(String(turn.status));
});

const dockedPendingInteractions = computed(() => collectDockedPendingInteractions(displayedMessages.value));

/** 输入框是否为空的镜像：预测闸门之一（有草稿就不该计时）。由 ChatInputArea 上抛。 */
const draftEmpty = ref(true);

const { suggestion: instructionPrediction, clear: clearInstructionPrediction } = useInstructionPredict({
  sessionId: computed(() => localActiveId.value),
  rootSessionId: computed(() => currentActiveSession.value?.rootSessionId ?? null),
  turnId: lastTurnId,
  turnCompleted: lastTurnCompleted,
  // 后端以「预测模型为空」表示功能关闭：前端据此免发必然返回空的请求。
  enabled: computed(() => userConfig.predicateModelId != null),
  inputEmpty: computed(() => draftEmpty.value),
});

const handleSidebarSessionSelect = (id: string): void => {
  if (localSessions.value.some(session => session.subSessions?.some(sub => String(sub.id) === id))) closePreviewPanel();
  void handleSelectSidebarSession(id);
};

/**
 * 用量审计浮动面板的展开态。
 *
 * <p>放在页面级而不是面板内部：触发按钮在消息区右上角入口行里，面板本身是绝对定位抽屉，
 * 二者需要共享同一个开关。默认收起 —— 这是辅助诊断面板，不该默认占屏。</p>
 */
const isTokenAuditOpen = ref(false);


// 卡片决策提交能力：注入给深层卡片组件（PlanCard / ApprovalCard / RequireChoiceCard）
provide(DECIDE_TOOL_CALL_KEY, decideToolCall);
provide(ANSWER_CHOICES_KEY, answerChoices);

const { packSlots } = usePackHost();

// 默认实现与官方扩展包槽位合并：未覆盖字段自动回落内置默认组件。
const messageSlots = shallowReactive({
  body: packSlots.chatMessage.body ?? MessageBodyDefault,
  actions: packSlots.chatMessage.actions ?? MessageActionsBar,
});
watch(
  () => [packSlots.chatMessage.body, packSlots.chatMessage.actions] as const,
  ([body, actions]) => {
    messageSlots.body = body ?? MessageBodyDefault;
    messageSlots.actions = actions ?? MessageActionsBar;
  },
);
provide(CHAT_MESSAGE_SLOTS_KEY, messageSlots);

/**
 * 主页背景装饰表面（L2 切片：本仓第一个**真实替换实现**的注册点，全仓唯一）。
 *
 * <p>优先级：用户自定义图片背景 > 扩展包自定义表面 > 内置令牌背景。
 * 用 shallowReactive 保证设置页换图或切换扩展包时表面实时响应。</p>
 */
const { hasBackground: hasBackgroundImage } = useBackgroundPreference();
const backgroundSlots = shallowReactive<{ surface: Component }>({
  surface: hasBackgroundImage.value ? ImageBackground : TokenBackground,
});
const syncBackgroundSurface = (): void => {
  backgroundSlots.surface = hasBackgroundImage.value
    ? ImageBackground
    : (packSlots.background.surface ?? TokenBackground);
};
watch(hasBackgroundImage, syncBackgroundSurface);
watch(() => packSlots.background.surface, syncBackgroundSurface, { immediate: true });
provide(BACKGROUND_SLOTS_KEY, backgroundSlots);

/**
 * 输入区插槽渲染器（合并官方扩展包槽位覆盖，未覆盖字段回落内置默认实现）。
 */
const inputSlots = shallowReactive({
  contextUsage: packSlots.chatInput.contextUsage ?? ChatInputContextUsage,
  modelSelector: packSlots.chatInput.modelSelector ?? ChatInputModelSelector,
  sendButton: packSlots.chatInput.sendButton ?? ChatInputSendButton,
});
watch(
  () => [packSlots.chatInput.contextUsage, packSlots.chatInput.modelSelector, packSlots.chatInput.sendButton] as const,
  ([contextUsage, modelSelector, sendButton]) => {
    inputSlots.contextUsage = contextUsage ?? ChatInputContextUsage;
    inputSlots.modelSelector = modelSelector ?? ChatInputModelSelector;
    inputSlots.sendButton = sendButton ?? ChatInputSendButton;
  },
);
provide(CHAT_INPUT_SLOTS_KEY, inputSlots);

/**
 * Sidebar 插槽渲染器（合并官方扩展包槽位覆盖，未覆盖字段回落内置默认实现）。
 */
const defaultWorkspaceTree = SidebarWorkspaceTree as unknown as Component<SidebarTreeSlotProps>;
const sidebarSlots = shallowReactive({
  workspaceTree: packSlots.sidebar.workspaceTree ?? defaultWorkspaceTree,
  sidebarFooter: packSlots.sidebar.sidebarFooter ?? SidebarFooterBar,
});
watch(
  () => [packSlots.sidebar.workspaceTree, packSlots.sidebar.sidebarFooter] as const,
  ([workspaceTree, sidebarFooter]) => {
    sidebarSlots.workspaceTree = workspaceTree ?? defaultWorkspaceTree;
    sidebarSlots.sidebarFooter = sidebarFooter ?? SidebarFooterBar;
  },
);
provide(SIDEBAR_SLOTS_KEY, sidebarSlots);

/**
 * 审批与计划卡片插槽渲染器（合并官方扩展包槽位覆盖，未覆盖字段回落内置默认实现）。
 */
const interactionCardSlots = shallowReactive({
  approvalCard: packSlots.interactionCard.approvalCard ?? ApprovalCard,
  planCard: packSlots.interactionCard.planCard ?? PlanCard,
  choiceGroup: packSlots.interactionCard.choiceGroup ?? ChoiceQuestionGroup,
});
watch(
  () => [packSlots.interactionCard.approvalCard, packSlots.interactionCard.planCard, packSlots.interactionCard.choiceGroup] as const,
  ([approvalCard, planCard, choiceGroup]) => {
    interactionCardSlots.approvalCard = approvalCard ?? ApprovalCard;
    interactionCardSlots.planCard = planCard ?? PlanCard;
    interactionCardSlots.choiceGroup = choiceGroup ?? ChoiceQuestionGroup;
  },
);
provide(INTERACTION_CARD_SLOTS_KEY, interactionCardSlots);

const resolvedPendingQueuePanel = computed(() => packSlots.taskProgress.pendingQueuePanel ?? PendingChatQueuePanel);
</script>

<style scoped>
/* 预览面板的开合动画归面板自己（宽度过渡 + 固定宽度画布），宿主不再包 Transition：
   宿主那层配 v-show 时，v-if 一变元素就被卸载，离场动画永远播不出来。 */

.pending-queue-enter-active,
.pending-queue-leave-active {
  transition: opacity 200ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pending-queue-enter-from,
.pending-queue-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.99);
}

.pending-item-enter-active,
.pending-item-leave-active {
  transition: opacity 180ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pending-item-move {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pending-item-enter-from,
.pending-item-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .pending-queue-enter-active,
  .pending-queue-leave-active,
  .pending-item-enter-active,
  .pending-item-leave-active,
  .pending-item-move {
    transition: none;
  }
}
</style>
