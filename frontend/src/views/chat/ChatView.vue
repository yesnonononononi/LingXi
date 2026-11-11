
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

        <!-- 文件预览入口：必须挂**在消息区容器内**做绝对定位。挂到右侧同级容器上时会按整个容器
             右缘对齐，而子代理面板可见时那个右缘属于面板本身 —— 按钮就会盖住面板头部的「收起」。
             两个入口并排：有文件标签时出现「文件预览」，页面预览入口则始终在（零文件标签也能进）。 -->
        <!-- 右上角多功能浮动控制栏：毛玻璃胶囊容器，整合文件预览、页面预览、设计原型与用量审计 -->
        <Transition name="panel-entries-fade">
          <div
            v-if="!previewPanelVisible"
            class="absolute right-4 top-3 z-30 inline-flex items-center gap-0.5 p-1 rounded-xl bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200/80 dark:border-zinc-800/80 shadow-[0_2px_10px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_14px_rgba(0,0,0,0.35)]"
          >
            <button
              v-if="fileTabs.length"
              type="button"
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/90 transition-colors cursor-pointer"
              @click="openFilePreviewPanel"
            >
              <svg class="w-3.5 h-3.5 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              <span>{{ t('chat.view.filePreview', { count: fileTabs.length }) }}</span>
            </button>
            <button
              type="button"
              data-test="chat-project-page-entry"
              :aria-label="t('chat.view.projectPagePreview')"
              :title="t('chat.view.projectPagePreview')"
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/90 transition-colors cursor-pointer"
              @click="openProjectPagePanel"
            >
              <svg class="w-3.5 h-3.5 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
              <span>{{ t('chat.view.projectPagePreview') }}</span>
            </button>
            <button
              type="button"
              data-test="chat-design-preview-entry"
              :aria-label="t('chat.view.designPreview')"
              :title="t('chat.view.designPreview')"
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/90 transition-colors cursor-pointer"
              @click="openDesignPreviewPanel"
            >
              <svg class="w-3.5 h-3.5 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.39m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
              </svg>
              <span>{{ t('chat.view.designPreview') }}</span>
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
        </Transition>

        <!-- 用量审计浮动面板：贴在消息区容器内做绝对定位（与上面的入口行同一坐标系），
             偏移 top-12 是为了不盖住入口行本身；高度由容器剩余空间约束，内部自行滚动。 -->
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
              <section
                class="w-full rounded-2xl border px-3.5 py-2.5 text-sm backdrop-blur-md transition-colors duration-200"
                :class="displayIsDark
                  ? 'border-white/[0.09] bg-zinc-950/90 text-zinc-100 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.65)]'
                  : 'border-zinc-200/85 bg-white/95 text-zinc-800 shadow-[0_6px_22px_-6px_rgba(24,24,27,0.07),0_1px_2px_rgba(24,24,27,0.04)]'"
                :aria-label="t('chat.pending.title')"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-lg"
                      :class="pendingQueue.snapshot.value.paused
                        ? (displayIsDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-500/10 text-amber-600')
                        : (displayIsDark ? 'bg-white/[0.08] text-zinc-300' : 'bg-zinc-100 text-zinc-600')"
                      aria-hidden="true"
                    >
                      <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2.5 4.5h11M2.5 8h7.5M2.5 11.5h5" />
                        <circle cx="12.5" cy="10.5" r="2.2" />
                      </svg>
                    </span>
                    <h3
                      class="text-xs font-medium tracking-tight"
                      :class="displayIsDark ? 'text-zinc-300' : 'text-zinc-600'"
                    >{{ t('chat.pending.count', {count: pendingQueue.snapshot.value.entries.length}) }}</h3>
                  </div>
                  <button
                    v-if="pendingQueue.snapshot.value.paused"
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    :class="displayIsDark
                      ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
                      : 'bg-zinc-900 text-white hover:bg-zinc-800'"
                    :disabled="pendingQueue.changing.value"
                    @click="pendingQueue.resume()"
                  >{{ t('chat.pending.resume') }}</button>
                </div>
                <p
                  v-if="pendingQueue.snapshot.value.failure || pendingQueue.error.value"
                  class="mt-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 dark:text-red-400"
                  role="alert"
                >
                  {{ pendingQueue.error.value || pendingQueue.snapshot.value.failure }}
                </p>
                <TransitionGroup tag="ol" name="pending-item" class="mt-2 max-h-32 space-y-1 overflow-y-auto pr-0.5 scrollbar-thin">
                  <li
                    v-for="(entry, index) in pendingQueue.snapshot.value.entries"
                    :key="entry.id"
                    class="group/item flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-xs transition-colors duration-150"
                    :class="displayIsDark
                      ? 'bg-white/[0.04] hover:bg-white/[0.07] text-zinc-200'
                      : 'bg-zinc-100/75 hover:bg-zinc-100 text-zinc-700'"
                  >
                    <span
                      class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md px-1 text-[10px] font-semibold tabular-nums select-none"
                      :class="displayIsDark ? 'bg-white/10 text-zinc-300' : 'bg-zinc-200/85 text-zinc-600'"
                    >{{ index + 1 }}</span>
                    <span class="min-w-0 flex-1 truncate leading-5" :title="entry.input">{{ entry.input }}</span>
                    <span
                      v-if="entry.dispatching"
                      class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium"
                      :class="displayIsDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-500/10 text-emerald-600'"
                    >
                      <span class="h-1.5 w-1.5 rounded-full bg-current lx-live-dot" aria-hidden="true" />
                      {{ t('chat.pending.sending') }}
                    </span>
                    <button
                      v-else
                      type="button"
                      class="shrink-0 inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      :class="displayIsDark
                        ? 'text-zinc-400 hover:bg-red-500/15 hover:text-red-300'
                        : 'text-zinc-500 hover:bg-red-500/10 hover:text-red-600'"
                      :aria-label="t('chat.pending.cancelNamed', {input: entry.input})"
                      :disabled="pendingQueue.changing.value"
                      @click="pendingQueue.cancel(entry.id)"
                    >{{ t('chat.pending.cancel') }}</button>
                  </li>
                </TransitionGroup>
              </section>
            </div>
          </Transition>
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
              :queueMessage="canQueueMessage ? handleQueueMessage : undefined"
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
              :mode="chatMode"
              :prediction="instructionPrediction"
              @sendMessage="handleSendMessage"
              @stopGeneration="handleStopGeneration"
              @updateModel="handleUpdateModel"
              @updateAccessMode="handleUpdateAccessMode"
              @updateReasoningEffort="handleUpdateReasoningEffort"
              @updateTeam="handleUpdateTeam"
              @updateAgent="handleUpdateAgent"
              @updateMode="handleUpdateMode"
              @applyPrediction="clearInstructionPrediction"
              @dismissPrediction="clearInstructionPrediction"
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

      <Transition name="preview-panel-slide">
        <FilePreviewPanel
          v-if="fileTabs.length || pagePreviewOpen || designPreviewOpen"
          v-show="previewPanelVisible"
          :tabs="fileTabs"
          :activeId="activeFileId"
          :isDark="displayIsDark"
          :mode="previewMode"
          @update:mode="handlePreviewModeChange"
          @activate="activeFileId = $event"
          @closeTab="closeFileTab"
          @close="closePreviewPanel"
          @refresh="refreshFile"
          @open="runFileAction('open')"
          @reveal="runFileAction('reveal')"
        />
      </Transition>

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
import {computed, onBeforeUnmount, onMounted, provide, ref, shallowReactive, watch} from 'vue';
import {t} from '../../i18n';
import {isOk} from '../../utils/api';
import {LogAPI} from '../../services/log';
import {useFilePreview} from '../../composables/useFilePreview';
import {useProjectPagePreview} from '../../composables/useProjectPagePreview';
import {provideChatInputFocus} from '../../composables/useChatInputFocus';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import type {PreviewPanelMode, ShowWithAgentPayload} from '../../types/projectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../types/projectPagePreview';
import ShowWithAgentModal from '../../components/chat/ShowWithAgentModal.vue';
import {ANSWER_CHOICES_KEY, DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {CHAT_MESSAGE_SLOTS_KEY} from '../../types/chatMessageSlots';
import MessageBodyDefault from '../../components/chat/MessageBodyDefault.vue';
import ChatBackground from '../../components/chat/ChatBackground.vue';
import TokenBackground from '../../components/background/TokenBackground.vue';
import ImageBackground from '../../components/background/ImageBackground.vue';
import {BACKGROUND_SLOTS_KEY} from '../../types/backgroundSlots';
import {useBackgroundPreference} from '../../composables/useBackgroundPreference';
import MessageActionsBar from '../../components/chat/MessageActionsBar.vue';
import {CHAT_INPUT_SLOTS_KEY} from '../../types/chatInputSlots';
import ChatInputContextUsage from '../../components/chat/ChatInputContextUsage.vue';
import ChatInputModelSelector from '../../components/chat/ChatInputModelSelector.vue';
import ChatInputSendButton from '../../components/chat/ChatInputSendButton.vue';
import FilePreviewPanel from '../../components/chat/FilePreviewPanel.vue';
import {useChatView} from './useChatView';
import {useInstructionPredict} from '../../composables/useInstructionPredict';
import {isTerminalTurnStatus} from '../../utils/turnStatus';
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
import type {ChatMode} from '../../types/chat';
import {assertChatInputCommands} from '../../utils/assertChatInputCommands';
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

const handleShowWithAgentSend = (data: { text: string; file: File }) => {
  showWithAgentOpen.value = false;
  handleSendMessage(data.text, chatMode.value === 'plan', null, null, [data.file]);
};

const handleShowWithAgentInsert = (data: { text: string; file: File }) => {
  showWithAgentOpen.value = false;
  inputAreaRef.value?.setAttachedImages([data.file]);
  inputAreaRef.value?.setInputText(data.text);
  inputAreaRef.value?.focusInput?.();
};

onMounted(() => {
  assertChatInputCommands(inputAreaRef.value, 'ChatView.onMounted');
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
provide(FILE_PREVIEW_KEY, openFilePreview);

/**
 * 预览面板的内容模式 + 项目页面预览状态。
 *
 * <p>项目页面的唯一真源是 {@link useProjectPagePreview}（由本组件持有并 provide）：
 * 面板外壳只传 `mode`，正文组件 inject 同一份状态 —— 面板被隐藏、切到文件模式都不会重置 iframe。</p>
 */
const previewMode = ref<PreviewPanelMode>('file');
const pagePreview = useProjectPagePreview();
provide(PROJECT_PAGE_PREVIEW_KEY, pagePreview);
const designPreviewOpen = ref(false);

/**
 * 面板可见性：文件链路（filePreviewOpen）、页面链路（pagePreview.open）与设计模式任一为真即显示。
 */
const previewPanelVisible = computed<boolean>(() => filePreviewOpen.value || pagePreview.open.value || designPreviewOpen.value);

/**
 * 页面模式是否已打开（模板用）。
 *
 * <p>模板里 `pagePreview.open` 拿到的是 Ref 对象（对象里的 ref 不会被自动解包），永远为真，
 * 会退化成「面板一直挂着」；这个顶层 computed 才是模板该读的布尔值。</p>
 */
const pagePreviewOpen = computed<boolean>(() => pagePreview.open.value);

/** 打开文件模式（有标签时才有这个入口）。 */
const openFilePreviewPanel = (): void => {
  previewMode.value = 'file';
  filePreviewOpen.value = true;
};

/** 打开项目页面模式：即使零个文件标签也能进，不去伪造文件标签。 */
const openProjectPagePanel = (): void => {
  previewMode.value = 'page';
  pagePreview.open.value = true;
};

/** 打开设计原型模式：即使零个文件标签也能进。 */
const openDesignPreviewPanel = (): void => {
  previewMode.value = 'design';
  designPreviewOpen.value = true;
};

/**
 * 面板内的模式切换。
 *
 * @param mode 目标模式。
 */
const handlePreviewModeChange = (mode: PreviewPanelMode): void => {
  previewMode.value = mode;
  if (mode === 'page') {
    pagePreview.open.value = true;
  } else if (mode === 'design') {
    designPreviewOpen.value = true;
  } else if (fileTabs.value.length) {
    filePreviewOpen.value = true;
  }
};

/**
 * 收起右侧预览面板。
 *
 * <p>收起 ≠ 销毁：文件标签收起后仍在（`useFilePreview.fileTabs` 不随面板关闭清空），
 * 网页标签也必须一致 —— 这里走 `pagePreview.hide()`（隐藏原生视图、保留主进程标签与登录态）。
 * 真正的销毁只发生在会话/工作区切换（隔离要求）与宿主卸载。</p>
 */
const closePreviewPanel = (): void => {
  filePreviewOpen.value = false;
  designPreviewOpen.value = false;
  pagePreview.hide();
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
  canQueueMessage,
  pendingQueue,
  handleQueueMessage,
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
  handleSelectSidebarSession,
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
} = useChatView({ inputAreaRef, messagesContainerRef, subSessionPanelVisible: computed(() => !previewPanelVisible.value) });

/** 配置真源（与 useChatView 同一个 store 实例）：这里只读指令预测模型是否配置。 */
const userConfig = useUserConfigStore();

/**
 * 指令预测：最后一轮的终态与轮次 id 全部取自后端下发的事实。
 *
 * <p>末轮 id 取「最后一条带 turnId 的消息」—— 失败/取消的轮次同样有终态正文值得预测下一句，
 * 因此不按成功与否过滤。</p>
 */
const lastTurnId = computed<string | null>(() => {
  const messages = displayedMessages.value;
  for (let index = messages.length - 1; index >= 0; index--) {
    const turnId = messages[index]?.turnId;
    if (turnId) return String(turnId);
  }
  return null;
});

const lastTurnTerminal = computed<boolean>(() => {
  const turnId = lastTurnId.value;
  if (!turnId) return false;
  const turn = currentActiveSession.value?.turns?.[turnId];
  return turn != null && isTerminalTurnStatus(String(turn.status));
});

const { suggestion: instructionPrediction, clear: clearInstructionPrediction } = useInstructionPredict({
  sessionId: computed(() => localActiveId.value),
  rootSessionId: computed(() => currentActiveSession.value?.rootSessionId ?? null),
  turnId: lastTurnId,
  turnTerminal: lastTurnTerminal,
  // 后端以「预测模型为空」表示功能关闭：前端据此免发必然返回空的请求。
  enabled: computed(() => userConfig.predicateModelId != null),
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

/**
 * 切换会话或工作区必须销毁页面实例。
 *
 * <p>否则新会话会复用上一个项目页面的登录态与表单内容，隔离边界就破了（计划书阶段一验收第 5 条）。
 * 文件标签维持既有行为，不在本阶段改动。</p>
 */
watch([localActiveId, localActiveWorkspaceId], () => {
  pagePreview.close();
});


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

<style scoped>
/* 预览面板抽屉滑入滑出平滑过渡：宽度协同过渡，杜绝瞬间挤压撞击左侧区域 */
.preview-panel-slide-enter-active,
.preview-panel-slide-leave-active {
  transition: width 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease-out;
  overflow: hidden !important;
}
.preview-panel-slide-enter-active > *,
.preview-panel-slide-leave-active > * {
  min-width: 540px;
}
.preview-panel-slide-enter-from,
.preview-panel-slide-leave-to {
  width: 0 !important;
  opacity: 0;
}

/* 右上角浮动操作栏淡入淡出过渡：进场延迟等待右侧预览面板完全收起，避免在收缩容器中央突兀闪现 */
.panel-entries-fade-enter-active {
  transition: opacity 0.2s ease 0.28s, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1) 0.28s;
}
.panel-entries-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
.panel-entries-fade-enter-from,
.panel-entries-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

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
