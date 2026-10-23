
<template>
  <div :class="['w-full py-3 px-2 sm:px-4 transition-colors', props.message.role === 'user' && !isDelegatedTask ? 'flex justify-end' : 'flex justify-start']">
    <DelegatedTaskMessage
      v-if="isDelegatedTask"
      :content="props.message.content"
      :recipientName="props.taskRecipientName"
      :isDark="isDark"
    />
    
    <!-- 1. 用户消息展示样式 (匹配左图：无头像，柔和浅蓝背景圆角气泡，下方展示时间与复制图标) -->
    <div v-else-if="props.message.role === 'user'" class="flex min-w-0 max-w-full flex-col items-end sm:max-w-2xl group" data-testid="user-message">
      <!-- 气泡内容 -->
      <div class="relative flex min-w-0 max-w-full items-center gap-2">
        <!-- 报错标识已移除：失败是轮次的属性，由回答组统一渲染（turn.status=FAILED + errorReason） -->
        <div
          data-testid="user-message-bubble"
          :class="[
            'min-w-0 max-w-full rounded-[18px] text-sm leading-relaxed whitespace-pre-wrap transition-colors [overflow-wrap:anywhere] overflow-hidden',
            userImageUrls.length ? 'p-2' : 'px-4 py-2.5',
            isDark ? 'bg-zinc-800 text-zinc-100 border border-white/[0.08] shadow-xs' : 'bg-[#edf3fc] text-gray-800'
          ]"
        >
          <div v-if="userImageUrls.length" class="mb-2 max-w-sm flex flex-wrap gap-2" data-testid="user-images">
            <img
              v-for="(imageUrl, index) in userImageUrls"
              :key="index"
              :src="imageUrl"
              :alt="t('chat.message.userUploadIndex', { index: index + 1 })"
              :class="userImageUrls.length > 1 ? 'h-28 w-28' : 'max-h-64 w-auto'"
              class="object-contain rounded-xl border border-black/10 dark:border-white/10 cursor-pointer hover:opacity-95 transition"
              @click="handleImageClick(imageUrl)"
            />
          </div>
          <div :class="userImageUrls.length ? 'px-2 pb-1' : ''" data-testid="user-message-text">
            {{ props.message.content }}
          </div>
        </div>
      </div>

      <!-- 气泡下方时间与复制图标 (完全匹配左图)；受理被拒的气泡额外标「未发送」并给重发入口 -->
      <div class="flex items-center gap-2 mt-1.5 text-xs text-lx-disabled pr-1 select-none">
        <span>{{ displayTime }}</span>
        <!-- 受理被拒：这条消息后端不存在（未进 transcript / 未进模型上下文），绝不呈现成已发送 -->
        <template v-if="props.message.unsent">
          <span class="text-amber-500 dark:text-amber-400 font-medium" data-testid="unsent-badge">
            {{ t('chat.message.unsent') }}
          </span>
          <button
            type="button"
            @click="emit('resendUnsent', props.message.id)"
            class="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition p-0.5"
            :title="t('chat.message.resendTip')"
          >
            {{ t('chat.message.resend') }}
          </button>
        </template>
        <button
          @click="copyContent"
          class="hover:text-gray-600 dark:hover:text-zinc-200 transition p-0.5"
          :title="copied ? t('common.copied') : t('chat.message.copyContent')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <button v-if="!props.message.unsent && props.message.turnId"
          type="button" data-testid="edit-resend" :disabled="!props.canResend || !props.message.serverMessageId"
          :aria-label="t('chat.controls.editResend')" :title="resendTitle" @click="emit('editResend', props.message)"
          class="hover:text-gray-600 dark:hover:text-zinc-200 transition p-0.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
          <svg class="w-3.5 h-3.5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m16 4 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 2. Agent 回复展示样式 (匹配右图：无头像，顶部折叠"已思考 >"及分割线，正文高亮，底部丰富状态操作栏) -->
    <div v-else class="flex flex-col items-start w-full max-w-3xl space-y-2.5">
      
      <!-- 顶部：思考过程与工具调用统一折叠区 (发光字体与差异化微光) -->
      <div v-if="hasProcessContent" class="w-full">
        <button
          type="button"
          @click="toggleProcess"
          class="flex items-center gap-1.5 text-xs select-none py-0.5 group transition cursor-pointer"
          :class="isDark ? 'text-zinc-200 hover:text-white' : 'text-gray-500 hover:text-gray-800'"
        >
          <span
            v-if="props.message.isThinking"
            :class="[
              'font-medium',
              isDark ? 'text-white text-glow-white animate-glow-pulse' : 'text-blue-600 animate-pulse'
            ]"
          >{{ processTitle }}</span>
          <span
            v-else
            class="font-medium"
            :class="isDark ? 'text-zinc-100 text-glow-white' : 'text-gray-600'"
          >{{ processTitle }}</span>
          <svg
            :class="['w-3.5 h-3.5 transition-transform duration-200', isProcessExpanded ? 'rotate-90' : '', isDark ? 'text-zinc-200 drop-shadow-[0_0_6px_rgba(255,255,255,0.4)]' : 'text-gray-400 group-hover:text-gray-600']"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <!-- 中间叙述与思考、工具共用折叠边界，正文在过程区外展示。 -->
        <CollapseTransition>
          <div v-if="isProcessExpanded">
            <div :class="['mt-2 pl-3 space-y-2.5', processTimeline.length > 0 ? (isDark ? 'border-l border-white/10' : 'border-l border-gray-200') : '']">
          <!-- 统一时序时间线：按执行先后顺序交替展示思维链 (深度思考)、中间文本与工具调用 -->
          <template v-for="item in processItems" :key="item.id">
            <!-- 思考标题和正文共用原有折叠状态。 -->
            <div v-if="item.type === 'thought' && item.step" class="text-[13px] space-y-1">
              <button
                type="button"
                @click="toggleThoughtStep(item.step.id, item.step)"
                class="font-medium flex items-center gap-1.5 cursor-pointer transition select-none py-0.5 text-left"
                :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'"
              >
                <svg
                  :class="['w-3 h-3 transition-transform duration-200 shrink-0', isThoughtStepExpanded(item.step) ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-gray-400']"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                <GradientText
                  v-if="isThoughtAnimating(item.step)"
                  :colors="['#40ffaa', '#4079ff', '#40ffaa', '#4079ff', '#40ffaa']"
                  :animation-speed="3"
                  :show-border="false"
                  class="tracking-wide !p-0"
                >{{ formatThoughtTitle(item.step.title) }}</GradientText>
                <span v-else class="tracking-wide">{{ formatThoughtTitle(item.step.title) }}</span>
              </button>

              <!-- 长思考保留滚动上限，避免撑满会话。 -->
              <CollapseTransition>
                <div v-if="isThoughtStepExpanded(item.step) && item.step.content" class="relative">
                  <div
                    :ref="(el) => item.step && setThinkingBoxRef(item.step.id, el)"
                    :class="[
                      'thinking-content my-2 ml-1 border-l-[3px] pl-4 pr-2 max-h-72 overflow-y-auto scrollbar-thin select-text',
                      isDark ? 'border-zinc-700' : 'border-zinc-200'
                    ]"
                    @scroll="handleThinkingScroll(item.step.id, $event)"
                  >
                    <MarkdownRenderer :content="item.step.content" :is-dark="isDark" :thinking-text="true" />
                  </div>
                  <!-- 用户上滑看前文后，新分片不再抢滚动位置；给一个一键回到底部的入口。
                       只在仍在流式的思考上出现 —— 已定型的内容停在顶部是正常的，不该催人回底部。 -->
                  <button
                    v-if="item.step.status === 'running' && !isThinkingFollowing(item.step.id)"
                    type="button"
                    @click="handleScrollThinkingToBottom(item.step.id)"
                    :class="[
                      'absolute bottom-2 right-2 flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] leading-none shadow-sm transition-colors cursor-pointer',
                      isDark
                        ? 'border-white/15 bg-[#1b2130]/90 text-zinc-300 hover:text-zinc-100'
                        : 'border-gray-200 bg-white/95 text-gray-500 hover:text-gray-800'
                    ]"
                  >
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v13M6 12l6 6 6-6" />
                    </svg>
                                        {{ t('chat.message.backToBottom') }}
                  </button>
                </div>
              </CollapseTransition>
            </div>

            <!-- 中间叙述只在展开过程时展示，避免与正文混淆。 -->
            <div
              v-else-if="item.type === 'intermediate_ai' && item.message"
            >
              <div
                v-if="item.message.text"
                class="pl-4.5 select-text"
              >
                <MarkdownRenderer
                  :content="item.message.text"
                  :is-dark="isDark"
                  :process-text="true"
                />
              </div>
            </div>

            <!-- 3. SubAgent 子代理多会话协同指示条 -->
            <div
              v-else-if="item.type === 'sub_agent' && item.subAgents?.length"
              :class="[
                'w-full min-w-0 px-3.5 py-2.5 rounded-2xl border flex items-center justify-between gap-3 text-xs select-none transition-colors overflow-hidden',
                props.isDark ? 'bg-[#141b29]/70 border-[#222d42] text-gray-200' : 'bg-blue-50/70 border-blue-200/80 text-blue-900'
              ]"
            >
              <!-- 左侧信息区：固定尺寸，禁止压缩，文案不折行 -->
              <div class="flex items-center gap-2.5 shrink-0 select-none">
                <div class="w-6 h-6 rounded-lg bg-linear-to-tr from-blue-500 to-indigo-600 flex items-center justify-center text-white shrink-0 shadow-2xs">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <div class="flex flex-col shrink-0">
                  <div class="flex items-center gap-1.5 whitespace-nowrap">
                                        <span class="font-medium">{{ t('chat.message.teamCollab') }}</span>
                    <span :class="['px-1.5 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap', props.isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700']">
                      {{ t('chat.message.membersWorking', { count: item.subAgents.length }) }}
                    </span>
                  </div>
                  <p class="text-[11px] text-gray-400 whitespace-nowrap">{{ t('chat.message.trajectoryOnRight') }}</p>
                </div>
              </div>

              <!-- 右侧成员列表：占用剩余空间，横向超出滚动，不溢出卡片 -->
              <div class="flex-1 min-w-0 flex items-center justify-end gap-1.5 overflow-x-auto scrollbar-thin py-0.5">
                <button
                  v-for="(tc, idx) in item.subAgents"
                  :key="tc.id || idx"
                  @click="emit('selectSubSession', tc.subSessionId || tc.id)"
                  :class="[
                    'px-2.5 py-1 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer shrink-0',
                    props.isDark ? 'border-blue-500/30 bg-blue-600/15 hover:bg-blue-600/25 text-blue-300' : 'border-blue-200 bg-white hover:bg-blue-100 text-blue-700'
                  ]"
                  :title="subAgentMemberTitle(tc, idx)"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="subAgentMemberDotClass(tc)"></span>
                  <span class="truncate max-w-28">{{ tc.subAgentName || `Agent #${tc.displayIndex || idx + 1}` }}</span>
                  <span class="text-[10px] opacity-60 shrink-0">#{{ tc.displayIndex ?? (idx + 1) }}</span>
                </button>
              </div>
            </div>

            <ReadImageToolGroup
              v-else-if="item.images?.length && props.sessionId"
              :images="item.images"
              :session-id="props.sessionId"
              :is-dark="isDark"
            />

            <!-- 4. 普通 Agent 工具调用展示 -->
            <div v-else-if="item.type === 'tool' && item.tool" class="w-full my-0.5">
              <!-- 普通工具调用 -->
              <div class="w-full">
                <!-- 头部操作条 (始终显示，带旋转指示箭头和类型图标) -->
                <div
                  @click="canExpandTool(item.tool) && toggleToolCall(item.tool.id)"
                  class="flex items-center gap-1.5 text-[13px] py-0.5 transition group select-none w-full max-w-full min-w-0 overflow-hidden text-left"
                  :class="toolRowHeaderClass(item.tool, isDark)"
                                    :title="cleanDisplayPath(getToolDescription(item.tool)) || resolveToolRenderName(item.tool.toolName)"
                >
                  <!-- 箭头列恒定占位：读文件没有详情不渲染箭头，缺了这格图标会左移一格，与可展开行的图标列对不齐 -->
                  <button v-if="canExpandTool(item.tool)" type="button" class="shrink-0 cursor-pointer" :aria-expanded="!!expandedToolIds[item.tool.id]" :aria-label="t('chat.message.viewToolDetail', { category: resolveToolRenderName(item.tool.toolName) })" @click.stop="toggleToolCall(item.tool.id)">
                  <svg
                    :class="['w-3.5 h-3.5 transition-transform duration-200 shrink-0', expandedToolIds[item.tool.id] ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-gray-400']"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  </button>
                  <span v-else class="w-3.5 h-3.5 shrink-0" aria-hidden="true"></span>
                  <div class="flex-shrink-0 flex items-center">
                    <svg v-if="getToolCategory(item.tool) === TOOL_CATEGORY.READ || getToolCategory(item.tool) === TOOL_CATEGORY.WRITE" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="4" y="3" width="16" height="18" rx="2" />
                      <path stroke-linecap="round" d="M8 8h8M8 12h8M8 16h4" />
                    </svg>
                    <svg v-else-if="getToolCategory(item.tool) === TOOL_CATEGORY.COMMAND" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="3" y="4" width="18" height="16" rx="3" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M7 9l3 3-3 3M13 15h4" />
                    </svg>
                    <svg v-else-if="getToolCategory(item.tool) === TOOL_CATEGORY.THINK" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="9" cy="9" r="3.5" />
                      <circle cx="15" cy="9" r="3.5" />
                      <circle cx="9" cy="15" r="3.5" />
                      <circle cx="15" cy="15" r="3.5" />
                    </svg>
                    <svg v-else class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <!-- 有目标路径/对象时（如读取/写入）：分类名 + 目标路径（读文件附行范围） -->
                  <template v-if="getToolTarget(item.tool)">
                    <span class="font-normal shrink-0" :class="isDark ? 'text-zinc-100 text-glow-white font-medium' : 'text-gray-700'">{{ resolveToolRenderName(item.tool.toolName) }}</span>
                    <button
                      type="button"
                      :disabled="!canPreviewFile(item.tool)"
                      :title="canPreviewFile(item.tool) ? t('chat.message.previewFile') : undefined"
                      @click.stop="openFilePreview?.(props.sessionId, getToolTarget(item.tool))"
                      class="border-b border-dotted font-mono text-[12.5px] pb-px transition-colors truncate min-w-0"
                      :class="isDark ? 'border-white/30 text-zinc-200 text-glow-subtle' : 'border-gray-400 text-gray-700'"
                    >
                      {{ cleanDisplayPath(getToolTarget(item.tool)) }}
                    </button>
                    <span
                      v-if="getToolLineRange(item.tool)"
                      class="font-mono text-[11.5px] shrink-0 select-none"
                      :class="isDark ? 'text-zinc-400' : 'text-gray-400'"
                    >
                      {{ getToolLineRange(item.tool) }}
                    </span>
                  </template>

                  <!-- 无目标路径时（如执行命令）：描述文本与分类名称二选一（优先描述文本，如「确保workspace依赖链接完整」；缺省回退「执行命令」） -->
                  <template v-else>
                    <button
                      type="button"
                      :disabled="!canExpandTool(item.tool)"
                      :aria-expanded="!!expandedToolIds[item.tool.id]"
                      @click.stop="toggleToolCall(item.tool.id)"
                      class="transition-colors truncate min-w-0 font-medium"
                      :class="isDark ? 'text-[13px] text-zinc-100 text-glow-white' : 'text-[13px] text-gray-700'"
                    >
                                            {{ cleanDisplayPath(getToolDescription(item.tool)) || resolveToolRenderName(item.tool.toolName) }}
                    </button>
                  </template>

                  <!-- edit_file 差异行指示（完全还原图片风格：绿+N 红-M） -->
                  <span
                    v-if="getToolDiffStat(item.tool)"
                    class="inline-flex items-center gap-1 font-mono text-[12px] font-medium leading-none shrink-0 select-none ml-1"
                  >
                    <span
                      v-if="getToolDiffStat(item.tool)!.plusLines !== undefined"
                      class="text-[#088f50] dark:text-emerald-400"
                    >+{{ getToolDiffStat(item.tool)!.plusLines }}</span>
                    <span
                      v-if="getToolDiffStat(item.tool)!.minusLines !== undefined"
                      class="text-[#b42c3f] dark:text-rose-400"
                    >-{{ getToolDiffStat(item.tool)!.minusLines }}</span>
                  </span>
                </div>

                <!-- 展开的工具详情卡片 (带平滑折叠动画)；读文件没有详情，见 canExpandTool -->
                <CollapseTransition>
                  <div v-if="canExpandTool(item.tool) && expandedToolIds[item.tool.id]">
                    <div :class="['w-full rounded-2xl border overflow-hidden mt-1.5 shadow-xs transition-colors', isDark ? 'border-[#273043] bg-[#12161f]' : 'border-gray-200/90 bg-white']">
                      <div :class="['px-4 py-2.5 flex items-center justify-between gap-3 text-xs border-b', isDark ? 'border-gray-800/80' : 'border-gray-100']">
                        <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden">
                          <span
                            :class="[
                              'w-2 h-2 rounded-full flex-shrink-0',
                              toolStatusDotClass(item.tool.status)
                            ]"
                          ></span>
                          <span class="text-gray-400 dark:text-gray-500 font-mono text-xs flex-shrink-0 select-none">
                            {{ item.tool.workDir }}
                          </span>
                          <span class="font-mono text-xs text-gray-800 dark:text-gray-200 truncate select-text">
                            {{ cleanDisplayPath(getToolDetail(item.tool)) }}
                          </span>
                          <!-- 卡片栏中的 diff 状态指示 -->
                          <span
                            v-if="getToolDiffStat(item.tool)"
                            class="inline-flex items-center gap-1 font-mono text-[12px] font-medium leading-none shrink-0 select-none ml-1"
                          >
                            <span
                              v-if="getToolDiffStat(item.tool)!.plusLines !== undefined"
                              class="text-[#088f50] dark:text-emerald-400"
                            >+{{ getToolDiffStat(item.tool)!.plusLines }}</span>
                            <span
                              v-if="getToolDiffStat(item.tool)!.minusLines !== undefined"
                              class="text-[#b42c3f] dark:text-rose-400"
                            >-{{ getToolDiffStat(item.tool)!.minusLines }}</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          @click.stop="copyToolContent(unwrapToolResultEnvelope(item.tool.result), item.tool.id)"
                          class="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition px-1 py-0.5 select-none flex-shrink-0 cursor-pointer"
                        >
                          {{ toolCopiedId === item.tool.id ? t('common.copied') : t('common.copy') }}
                        </button>
                      </div>

                      <div class="p-4">
                        <!-- edit_file 工具展示增删对比块 -->
                        <div v-if="isEditFileToolCall(item.tool.toolName) && getEditFileDiffChunks(item.tool)" class="space-y-2.5 font-mono text-xs select-text">
                          <div v-if="getEditFileDiffChunks(item.tool)!.oldText" class="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-[#b42c3f] dark:text-rose-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                            <div class="text-[11px] font-sans font-medium text-red-500/80 dark:text-red-400/80 mb-1.5 select-none flex items-center gap-1.5">
                              <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                              <span>{{ t('chat.message.diffBefore') }}</span>
                            </div>
                            {{ getEditFileDiffChunks(item.tool)!.oldText }}
                          </div>
                          <div v-if="getEditFileDiffChunks(item.tool)!.newText" class="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-[#088f50] dark:text-emerald-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                            <div class="text-[11px] font-sans font-medium text-emerald-600/80 dark:text-emerald-400/80 mb-1.5 select-none flex items-center gap-1.5">
                              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                              <span>{{ t('chat.message.diffAfter') }}</span>
                            </div>
                            {{ getEditFileDiffChunks(item.tool)!.newText }}
                          </div>
                        </div>
                        <pre
                          v-else-if="item.tool.result"
                          :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[380px] scrollbar-thin select-text', isDark ? 'text-gray-200' : 'text-gray-800']"
                        >{{ unwrapToolResultEnvelope(item.tool.result) }}</pre>
                        <div v-else-if="item.tool.status === 'pending'" class="font-mono text-xs text-amber-500/90 flex items-center gap-2">
                          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                                                    <span>{{ t('chat.message.awaitingDecision') }}</span>
                        </div>
                        <div v-else-if="isToolInProgress(item.tool.status)" class="font-mono text-xs text-gray-400">{{ t('chat.message.toolInProgress') }}</div>
                        <pre
                          v-else-if="shouldShowToolArguments(item.tool.toolName) && item.tool.query"
                          :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto select-text', isDark ? 'text-gray-400' : 'text-gray-600']"
                        >{{ item.tool.query }}</pre>
                        <div v-else class="text-xs text-gray-400 font-mono">
                                                    {{ t('chat.message.noOutput') }}
                        </div>
                      </div>
                    </div>
                  </div>
                </CollapseTransition>
              </div>
            </div>
          </template>

          <!-- 探索中渐变动画 (紧贴最后一条消息块底部) -->
          <div v-if="props.message.isExploring" class="py-1 flex items-center justify-start select-none">
            <GradientText
              :colors="['#3b82f6', '#6366f1', '#a855f7', '#38bdf8', '#3b82f6']"
              :animation-speed="2.5"
              :show-border="false"
              class="text-sm font-medium tracking-wide !mx-0 !ml-0"
            >
                            {{ t('chat.message.exploring') }}
            </GradientText>
          </div>
        </div>
      </div>
    </CollapseTransition>

        <!-- 细横线分割条 -->
        <div v-if="!props.message.isExploring" class="border-b border-gray-200/70 dark:border-gray-800/80 w-full mt-2 mb-2.5"></div>
      </div>

      <!-- 统一互动卡片：PLAN / CHOICE / COMMAND 三类 PROMISE 卡片（含 UNAVAILABLE）。
           渲染在过程折叠区之外，作为一等时间线项，确保用户可操作项不会被吞进折叠框。 -->
      <template v-for="entry in groupedCardItems" :key="entry.id">
        <CommandApprovalGroup
          v-if="entry.commands"
          :entries="entry.commands"
          :session-id="props.sessionId"
          :is-dark="isDark"
        />
        <ChoiceQuestionGroup
          v-else-if="entry.choices"
          :entries="entry.choices"
          :response-id="entry.responseId!"
          :expected-count="props.message.toolCalls?.filter(call => call.responseId === entry.responseId && call.toolName === AgentToolName.RequireChoice).length ?? 0"
          :is-dark="isDark"
        />
        <!-- 待决策卡片整卡展开（要按键）；已决卡片默认收成一行，细节按需展开 -->
        <div v-else-if="!entry.card.pending" class="w-full">
          <button
            type="button"
            @click="toggleCard(entry.id)"
            class="w-full flex items-center gap-1.5 text-xs py-1 transition select-none text-left cursor-pointer min-w-0"
            :class="isDark ? 'text-zinc-300 hover:text-zinc-100' : 'text-gray-600 hover:text-gray-900'"
          >
            <svg
              :class="['w-3 h-3 transition-transform duration-200 shrink-0', isCardExpanded(entry.id) ? 'rotate-90' : '']"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <!-- 已决卡片摘要：状态点 + 类型图标，与过程区灰字拉开层级 -->
            <span :class="['w-1.5 h-1.5 rounded-full shrink-0', cardDotClass(resolveCardTone(entry.card))]"></span>
            <svg
              class="w-3.5 h-3.5 shrink-0 text-lx-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" :d="cardKindIconPath(entry.card.kind)" />
            </svg>
            <span class="truncate">{{ cardSummary(entry.card) }}</span>
          </button>
          <CollapseTransition>
            <div v-if="isCardExpanded(entry.id)">
              <PromptCard
                :prompt-card="entry.card"
                :session-id="props.sessionId"
                :is-dark="isDark"
              />
            </div>
          </CollapseTransition>
        </div>
        <PromptCard
          v-else
          :prompt-card="entry.card"
          :session-id="props.sessionId"
          :is-dark="isDark"
        />
      </template>

      <transition name="context-compact-fade">
        <div
          v-if="props.message.isCompressingContext || props.message.modelRetry"
          role="status"
          class="w-full my-3 py-1 flex items-center gap-3 select-none context-compact-bar"
          :title="props.message.isCompressingContext && props.message.contextUsage?.tokenCount ? t('chat.message.contextTitle', { used: props.message.contextUsage.tokenCount, max: props.message.contextUsage.maxTokens || 0 }) : activityStatusText"
        >
          <!-- 两侧等分剩余空间，保证提示始终居中。 -->
          <div class="flex-1 min-w-0 h-[1px] bg-gray-200 dark:bg-gray-700/60"></div>

          <div class="flex items-center gap-1.5 text-xs text-lx-muted font-normal shrink-0">
            <svg v-if="props.message.isCompressingContext" class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <svg v-else class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 7v5h-5M4 17v-5h5" />
              <path d="M6.1 7a7 7 0 0 1 11.55-2L20 8M4 16l2.35 3A7 7 0 0 0 17.9 17" />
            </svg>
            <span class="context-compact-shimmer-text">{{ activityStatusText }}</span>
          </div>

          <div class="flex-1 min-w-0 h-[1px] bg-gray-200 dark:bg-gray-700/60"></div>

        </div>
      </transition>

      <!-- 回复正文 (使用 Markdown 渲染，包含代码高亮、代码块复制、表格与列表) -->
      <div
        v-if="props.message.content || (props.message.isThinking && !props.message.isExploring)"
        class="w-full text-sm font-normal my-1"
      >
        <MarkdownRenderer
          :content="props.message.content"
          :is-dark="props.isDark"
          :is-thinking="props.message.isThinking && !props.message.isExploring"
        />
      </div>

      <!-- 底部工具与状态栏 (对应右图：复制、赞、踩、重试、用量、耗时、时间) - 仅在会话生成结束时展示 -->
      <!-- 出现时机契约：活跃期只跟随后端终结/开始事件（isMessageCompleted）；非活跃期按 turnId 回答组 -->
      <!-- 收敛为组尾一次（isGroupTail !== false），避免同一轮次「本地气泡 + 对账行」并存时双工具条 -->
      <div v-if="isMessageCompleted && isGroupTail !== false" class="flex flex-wrap items-center gap-4 pt-1 text-xs text-gray-400 select-none">
        <!-- 复制图标 -->
        <button
          @click="copyContent"
          class="hover:text-gray-600 dark:hover:text-gray-200 transition p-0.5"
          :title="copied ? t('common.copied') : t('chat.message.copyAnswer')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>


        <!-- 执行状态（仅回答组有摘要时展示；进行中/失败/终态不同配色，失败附带原因全文 title） -->
        <!-- min-w-0 + 原因单独限宽：whitespace-nowrap 的 flex 子项默认按内容撑开，
             长异常串会把用量/耗时挤到下一行。压不下来就永远「底部状态栏被吃掉」。 -->
        <div v-if="execStatusMeta" class="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap" :title="execStatusMeta.errorReason">
          <span
            :class="[
              'w-1.5 h-1.5 rounded-full shrink-0',
              execStatusMeta.failed ? 'bg-red-500' : execStatusMeta.running ? 'bg-amber-400 animate-pulse' : 'bg-gray-500'
            ]"
          ></span>
          <span class="shrink-0" :class="execStatusMeta.failed ? (isDark ? 'text-red-400' : 'text-red-600') : ''">{{ execStatusMeta.text }}</span>
          <span
            v-if="execStatusMeta.errorReason"
            class="min-w-0 max-w-[16rem] truncate cursor-help text-red-500/90"
            :title="execStatusMeta.errorReason"
          >{{ t('common.colon') }}{{ execStatusMeta.errorReason }}</span>
        </div>

        <TokenUsagePopover v-if="showExecutionMeta" class="shrink-0" :usage="tokenUsage" :model-name="turn?.modelName"
          :model-provider="turn?.modelProvider" :is-dark="isDark" />

        <!-- 耗时统计（组尾展示一次；标注「总历时包含等待时间」） -->
        <div v-if="showExecutionMeta" class="flex shrink-0 whitespace-nowrap items-center gap-1">
          <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{{ t('chat.message.usageDuration', { duration: displayDuration }) }}</span>
        </div>

        <!-- 时间戳 -->
        <span class="shrink-0">{{ displayTime }}</span>
      </div>
    </div>


  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject } from 'vue';
import { FILE_PREVIEW_KEY } from '../../types/filePreview';
import type { ChatMessage, ThoughtStep, ToolCallTrace, SubSessionVO, ProcessTimelineItem, ChatTurn, PromptCardData, SubItemStatus } from '../../types/chat';
import { toPromptCardData, buildCardSummary } from '../../utils/toolCallCard';
import { cardDotClass, cardKindIconPath, resolveCardTone } from '../../utils/cardUi';
import {
  isEditFileTool,
  isReadFileTool,
  shouldShowToolArguments,
  isSubAgentTool,
    resolveToolMeta,
  extractSubAgentParams,
  unwrapToolResultEnvelope,
  TOOL_CATEGORY,
} from '../../utils/toolMeta';
import { compareResponsePosition } from '../../utils/responseOrder';
import { toObject } from '../../utils/json';
import { isAsyncDelegation, asyncSubSessionStatus, subItemStatusDotClass } from '../../utils/asyncDelegation';
import { AgentToolName } from '../../utils/toolNames';
import { resolveToolRenderName } from '../../utils/toolDisplayNames';
import { isActiveTurnStatus, isFailedTurnStatus, turnStatusLabel } from '../../utils/turnStatus';
import { formatDurationOrPlaceholder } from '../../utils/format';
import { resolveTokenUsage } from '../../utils/tokenUsage';
import TokenUsagePopover from './TokenUsagePopover.vue';
import { parseToolDiff } from '../../utils/toolDiff';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useStreamStickyScroll } from '../../composables/useStreamStickyScroll';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import GradientText from '../common/GradientText.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import DelegatedTaskMessage from './DelegatedTaskMessage.vue';
import PromptCard from './PromptCard.vue';
import CommandApprovalGroup from './CommandApprovalGroup.vue';
import { groupCommandApprovals, groupChoiceQuestions, type PromptCardEntry } from '../../utils/promptCardGroups';
import ChoiceQuestionGroup from './ChoiceQuestionGroup.vue';
import CollapseTransition from '../common/CollapseTransition.vue';
import ReadImageToolGroup from './ReadImageToolGroup.vue';
import { groupReadImageTools } from '../../utils/readImageTools';

const props = defineProps<{
  message: ChatMessage;
  taskRecipientName?: string;
  subSessions?: SubSessionVO[];
  isDark?: boolean;
  /** 消息所属会话 id：互动卡片的决策接口据此定位 */
  sessionId?: string | number;
  /**
   * 本条消息所属回答组的轮次信息（按 turnId 从会话轮次表解析）。
   * null = 无轮次（旧数据 / 未采集），**绝不**回落成会话累计用量或 0。
   */
  turn?: ChatTurn | null;
  /**
   * 是否为所在回答组的末条：仅组尾展示一次执行元信息（模型/提供方/token/状态/总历时），
   * 避免「同一执行跨页」时两个部分组各挂一次。
   */
  isGroupTail?: boolean;
  isLastAssistant?: boolean;
  isSending?: boolean;
  canResend?: boolean;
}>();

const { isDark: globalIsDark } = useTheme();
const userImageUrls = computed(() => props.message.imageUrls ?? (props.message.imageUrl ? [props.message.imageUrl] : []));
const resendTitle = computed(() => !props.message.serverMessageId ? t('chat.controls.messageSyncPending')
  : !props.canResend ? t('chat.controls.waitUntilIdle') : t('chat.controls.editResend'));
const isDark = computed(() => props.isDark ?? globalIsDark.value);
const activityStatusText = computed(() => props.message.isCompressingContext
  ? t('chat.message.compressing')
  : props.message.modelRetry ? t('chat.message.retrying', { count: props.message.modelRetry.retryCount }) : '');
// 委派身份由后端父轮次声明，不能从任务文本或会话位置猜测。
const isDelegatedTask = computed(() => props.message.role === 'user' && !!props.turn?.parentTurnId);
const openFilePreview = inject(FILE_PREVIEW_KEY);
const canPreviewFile = (tool: ToolCallTrace) => !!openFilePreview && (isReadFileTool(tool.toolName) || isEditFileTool(tool.toolName));

const emit = defineEmits<{
  (e: 'selectSubSession', id: string | number): void;
  /** 重发一条「未发送」的提问（受理被拒留下的本地气泡）。 */
  (e: 'resendUnsent', messageId: string): void;
  (e: 'editResend', message: ChatMessage): void;
}>();

/**
 * 是否还有工具停在「未收尾」态（调用中 / 待定）。
 *
 * <p>「未收尾」= 工具已经发起但还没拿到终态。只看这两种状态，不看成功/失败：
 * 历史行里工具恒为 success/failed，不会命中，因此不会把已完成的历史轮次误判成运行中。</p>
 */
function hasPendingTool(toolCalls?: ToolCallTrace[]): boolean {
  if (!toolCalls || toolCalls.length === 0) return false;
  return toolCalls.some(call => call != null && (call.status === 'calling' || call.status === 'pending'));
}

// 过程折叠状态：默认「轮次仍在跑就展开、已终结就收起」。
//
// ⚠️ 不能用 `isComplete === false` 作初值：`isComplete` 只表示「这一条已是权威行」
// （历史重建 / 已落库），不代表轮次终结 —— 对账重建的行恒为 true，而那一刻可能还有工具
// 停在调用中。用它作初值会让「正在跑的多轮工具调用」一挂载就是收起的（用户截图的现象）。
// 改由 processInitialExpanded 在挂载时一次性判定，之后交给 watch 处理。
const isProcessExpanded = ref(processInitialExpanded());

/**
 * 挂载时过程框是否展开。
 *
 * <p>展开 = 「轮次还没结束」：仍在思考 / 已发起但未收尾的工具 / 调用方明确的未完成
 * 或「发送中且是最新回答」。这些是**事实**，与 `isComplete` 是否已落库无关。</p>
 *
 * <p>刻意不复制 isTurnRunning 的全部判据：`turn` 摘要在挂载瞬间可能尚未解析出来，
 * 拿它判「活跃」会漏掉真正活跃的轮次。这里只认最硬的两条 —— 未收尾工具与显式未完成标记。</p>
 */
function processInitialExpanded(): boolean {
  if (props.message.isComplete === false) return true;
  if (props.message.isThinking || props.message.isExploring) return true;
  if (hasPendingTool(props.message.toolCalls)) return true;
  return props.isSending === true && props.isLastAssistant === true;
}
/**
 * 用户是否手动干预过过程框的展开态。
 *
 * <p>一旦用户点过折叠/展开按钮，自动逻辑（终结跳变）就不再覆盖他的选择 ——
 * 否则「用户刚展开 → 一条迟到的 isComplete 跳变把它收回」会让人觉得按钮失灵。</p>
 */
const processToggleOverride = ref(false);
const toggleProcess = (): void => {
  processToggleOverride.value = true;
  isProcessExpanded.value = !isProcessExpanded.value;
};
// 复制反馈（消息正文按布尔键控；见 composables/useCopyFeedback.ts）
const { isCopied: copied, copy: copyContentRaw } = useCopyFeedback();

// 工具调用展开与复制状态
const expandedToolIds = ref<Record<string, boolean>>({});
// 复制反馈（工具卡片按 toolCall.id 键控；见 composables/useCopyFeedback.ts）
const { copiedKey: toolCopiedId, copy: copyToolContentRaw } = useCopyFeedback();

// 思考步骤 (Thought for) 独立展开/折叠状态
const expandedThoughtStepIds = ref<Record<string, boolean>>({});

// 挂起和终态立即卸载动效，历史思考不保留动画帧回调。
const isThoughtAnimating = (step: ThoughtStep): boolean =>
  step.status === 'running' && !props.message.isSuspended
  && (props.turn ? props.turn.status === 'RUNNING' : props.message.isComplete !== true);

const isThoughtStepExpanded = (step: ThoughtStep) => {
  if (expandedThoughtStepIds.value[step.id] !== undefined) {
    return expandedThoughtStepIds.value[step.id];
  }
  // 如果步骤正在运行且消息未完成，默认展开显示流式思考；否则（如已完成消息）默认折叠
  return step.status === 'running' && props.message.isComplete === false;
};

const toggleThoughtStep = (stepId: string, step: ThoughtStep) => {
  expandedThoughtStepIds.value[stepId] = !isThoughtStepExpanded(step);
};

const formatThoughtTitle = (title?: string): string => {
  if (!title) return t('chat.message.deepThought');
  const trimmed = title.trim();
  if (trimmed === 'Thought for' || trimmed === 'Thought' || trimmed === '思考过程' || trimmed === '思考' || trimmed.toLowerCase() === 'thought for') {
    return t('chat.message.deepThought');
  }
  return trimmed;
};

// 思考内容展开框的流式贴底：判定规则与实现见 composables/useStreamStickyScroll.ts。
// 指纹覆盖**全部**思考步骤 —— 只盯「当前 running 的那一段」会漏：上一段没收到完成通知时
// 会一直占着 running，新一段的增量就再也触发不了贴底。
const {
  setBoxRef: setThinkingBoxRef,
  handleScroll: handleThinkingScroll,
  isFollowing: isThinkingFollowing,
  scrollToBottom: handleScrollThinkingToBottom
} = useStreamStickyScroll({
  streamSignature: () => {
    const steps = props.message.thoughtSteps;
    if (!steps || steps.length === 0) return '';
    return steps.map((step) => `${step.id}:${step.content?.length ?? 0}`).join('|');
  },
  boxIds: () => {
    const steps = props.message.thoughtSteps;
    if (!steps || steps.length === 0) return [];
    return steps.map((step) => String(step.id));
  },
  // 只有还在跑的思考才从贴底开始：已定型的思考一旦展开，应当从头读，
  // 也不能被别处的增量顶到底部。
  shouldStickOnMount: (id) =>
    props.message.thoughtSteps?.some((step) => String(step.id) === id && step.status === 'running') ?? false
});

// 计时器（按秒计算）
const now = ref(Date.now());
let timerInterval: number | undefined;

onMounted(() => {
  if (props.message.isComplete === false) {
    timerInterval = window.setInterval(() => {
      now.value = Date.now();
    }, 1000);
  }
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = undefined;
  }
});

// 中间轮次的 aimessage（与正文同文本的条目不再重复展示，其余中间过程文本归入折叠块）
//
// 判据用「文本是否等于正文」而非「是否为最后一个元素」：正文取 props.message.content，
// 与 aiMessages 的末条不必等价（历史解析会去重、流式恢复会重放），按位置切会在
// 「末条不等于正文」时把正文又重复渲染到折叠区里。
const intermediateAiMessages = computed(() => {
  const list = props.message.aiMessages;
  if (!list || list.length === 0) {
    return [];
  }
  const body = (props.message.content ?? '').trim();
  const seen = new Set<string>();
  const out: typeof list = [];
  for (const m of list) {
    const text = (m.text ?? '').trim();
    if (!text || text === body || seen.has(text)) continue;
    seen.add(text);
    out.push(m);
  }
  return out;
});

// 只有中间叙述时也需要折叠入口，否则过程文本无法展开。
const hasProcessContent = computed(() => {
  return !!(
    props.message.thoughtSteps?.length ||
    props.message.isThinking ||
    props.message.toolCalls?.length ||
    intermediateAiMessages.value.length > 0
  );
});

// 折叠栏头部标题文案
const processTitle = computed(() => {
  if (props.message.isThinking) {
    return props.message.content ? t('chat.message.generating') : t('chat.message.thinking');
  }
  const toolCount = props.message.toolCalls?.length || 0;
  const hasThoughts = !!(props.message.thoughtSteps?.length);

  if (hasThoughts && toolCount > 0) {
    return t('chat.message.thoughtAndTools', { count: toolCount });
  }
  if (toolCount > 0) {
    return t('chat.message.tools', { count: toolCount });
  }
  if (hasThoughts) {
    return t('chat.message.thought');
  }
  return t('chat.message.process');
});

const toggleToolCall = (id: string) => {
  expandedToolIds.value[id] = !expandedToolIds.value[id];
};

const copyToolContent = (text: string, id: string) => {
  void copyToolContentRaw(text, id);
};

const isSubAgentToolCall = (tc?: ToolCallTrace): boolean => isSubAgentTool(tc?.toolName, tc?.category);
const isEditFileToolCall = (toolName?: string): boolean => isEditFileTool(toolName);

/**
 * 该工具是否有可展开的详情。
 *
 * <p>读文件没有：头部一行已给全（读了哪个文件），展开拿不到头部没有的信息，
 * 只会把「路径 + 状态」重复一遍。其余工具（命令、编辑、检索等）保留详情。</p>
 */
const canExpandTool = (tc?: ToolCallTrace): boolean => !!tc && !isReadFileTool(tc.toolName);

/**
 * 展示文案字段映射（契约 §4）：按工具名映射到各自规范字段。
 * 命令 → `intention`，子代理 → `task`，计划 → `title`，提问 → `question`；未列出的工具不展示文案。
 */





/**
 * 聚合子代理协同成员：
 * 同一子会话可能被多次调用复用（如多次委派产品经理），按 subSessionId / agentId 去重合并，
 * 并与 props.subSessions 关联取得权威名称与团队序号，解决成员数量虚增与名字回退为 Agent #N 的问题。
 */
const subAgentToolCalls = computed<ToolCallTrace[]>(() => {
  const tcs = props.message.toolCalls?.filter(tc => isSubAgentToolCall(tc)) || [];
  if (tcs.length === 0) return [];

  const map = new Map<string, ToolCallTrace>();

  tcs.forEach((tc, idx) => {
    const params = extractSubAgentParams(tc);
    const agentId = params.agentId ?? tc.subAgentId;
    const subSessionId = tc.subSessionId ?? params.subSessionId;

    // 优先匹配当前会话绑定的权威 subSessions
    const matchedSub = (subSessionId
      ? props.subSessions?.find(s => String(s.id) === String(subSessionId))
      : undefined)
      || (agentId ? props.subSessions?.find(s => String(s.agentId) === String(agentId)) : undefined);

    // 计算在团队中的真实序号（1-indexed）
    let displayIndex = idx + 1;
    if (props.subSessions?.length) {
      const subIdx = props.subSessions.findIndex(s =>
        (subSessionId && String(s.id) === String(subSessionId)) ||
        (agentId && String(s.agentId) === String(agentId))
      );
      if (subIdx !== -1) {
        displayIndex = subIdx + 1;
      }
    }

    const agentName = matchedSub?.agentName
      || matchedSub?.name
      || params.agentName
      || tc.subAgentName
      || (agentId ? `Agent #${agentId}` : t('chat.message.subAgentIndex', { index: displayIndex }));

    const resolvedSubSessionId = subSessionId || matchedSub?.id || tc.subSessionId;
    const resolvedAgentId = agentId || matchedSub?.agentId;

    // 去重键：优先子会话 ID，其次 agentId
    const key = String(resolvedSubSessionId || resolvedAgentId || tc.id || `tc-${idx}`);

    const existing = map.get(key);
    if (existing) {
      // 若多次调用复用，更新状态与相关属性
      existing.status = tc.status || existing.status;
      if (tc.order !== undefined) existing.order = tc.order;
      if (resolvedSubSessionId && !existing.subSessionId) existing.subSessionId = resolvedSubSessionId;
      if (agentName && !existing.subAgentName) existing.subAgentName = agentName;
    } else {
      map.set(key, {
        ...tc,
        subSessionId: resolvedSubSessionId,
        subAgentId: resolvedAgentId,
        subAgentName: agentName,
        displayIndex,
        order: tc.order ?? idx
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
});

const regularToolCalls = computed<ToolCallTrace[]>(() => {
  return props.message.toolCalls?.filter(tc => !isSubAgentToolCall(tc)) || [];
});

/**
 * 协同条成员行的展示态：改由<b>子会话权威态</b>驱动。
 *
 * <p>协作式委派下工具会立即 COMPLETED，但子代理可能还在跑；继续读 `tc.status` 会把
 * 「执行中」误显示成「已完成」（P0-6 误判点之一）。这里优先用匹配到的子会话 `runStatus/lastOutcome`
 * 派生展示态（复用 {@link asyncSubSessionStatus}），子会话缺省时才回落工具状态。</p>
 */
const subAgentMemberStatus = (tc: ToolCallTrace): SubItemStatus => {
  const params = extractSubAgentParams(tc);
  const agentId = params.agentId ?? tc.subAgentId;
  const subSessionId = tc.subSessionId ?? params.subSessionId;
  const matchedSub = (subSessionId
    ? props.subSessions?.find(s => String(s.id) === String(subSessionId))
    : undefined)
    || (agentId ? props.subSessions?.find(s => String(s.agentId) === String(agentId)) : undefined);
  return asyncSubSessionStatus(matchedSub, tc);
};

const subAgentMemberDotClass = (tc: ToolCallTrace): string => subItemStatusDotClass(subAgentMemberStatus(tc));

/** 成员行 title：协作式委派说明结果以邮件送达（阻塞式保持原提示）。 */
const subAgentMemberTitle = (tc: ToolCallTrace, idx: number): string => {
  const name = tc.subAgentName || `Agent #${tc.displayIndex || idx + 1}`;
    return isAsyncDelegation(tc)
    ? t('chat.message.asyncDelegationTip', { name })
    : t('chat.message.viewSubSessionTip', { name });
};

/** 卡片无对应工具行时的排序基准（大于任何 rowIndex 派生的工具 order，保证卡片排在过程项之后） */
const CARD_ORDER_BASE = 1_000_000;

// 统一执行过程时间线：按真实时序交替排列思维链思考 (Thought for)、中间轮次文本、子代理协同与工具调用
const processTimeline = computed<ProcessTimelineItem[]>(() => {
  const items: ProcessTimelineItem[] = [];

  // 1. 思维链思考步骤
  if (props.message.thoughtSteps?.length) {
    props.message.thoughtSteps.forEach((step, idx) => {
      items.push({
        id: step.id || `step-${idx}`,
        type: 'thought',
        order: step.order ?? Infinity,
        responseId: step.responseId,
        step
      });
    });
  }

  // 2. 中间轮次 aimessage 文本（多轮执行时产生的中间说明，非最终结论）
  if (intermediateAiMessages.value.length) {
    intermediateAiMessages.value.forEach((im, idx) => {
      items.push({
        id: im.id || `im-${idx}`,
        type: 'intermediate_ai',
        order: im.order ?? Infinity,
        responseId: im.responseId,
        message: im
      });
    });
  }

  // 3. SubAgent 协同条（按首个子会话时间线位置插入）
  if (subAgentToolCalls.value.length > 0) {
    const firstSubTool = [...subAgentToolCalls.value].sort(compareResponsePosition)[0];
    items.push({
      id: 'sub-agents-banner',
      type: 'sub_agent',
      order: firstSubTool?.order ?? Infinity,
      responseId: firstSubTool?.responseId,
      subAgents: subAgentToolCalls.value
    });
  }

  // 4. 普通 Agent 工具调用
  if (regularToolCalls.value.length > 0) {
    regularToolCalls.value.forEach((tc, idx) => {
      items.push({
        id: tc.id || `tool-${idx}`,
        type: 'tool',
        order: tc.order ?? Infinity,
        responseId: tc.responseId,
        tool: tc
      });
    });
  }

  // 5. 互动卡片（PLAN / CHOICE / COMMAND 三类 PROMISE 卡片）：参与同一时序集合，
  //    但模板里被分离到过程折叠区之外渲染 —— 用户可操作项不能被吞进「已思考并调用工具」大框。
  if (props.message.promptCards?.length) {
    props.message.promptCards.forEach((card, idx) => {
      const trace = props.message.toolCalls?.find(tc => String(tc.id) === String(card.id));
      items.push({
        id: `card-${card.id ?? idx}`,
        type: 'prompt_card',
        order: trace?.order ?? (CARD_ORDER_BASE + idx),
        responseId: trace?.responseId,
        card
      });
    });
  }

  // 不能按片段或工具的到达时间排，乱序事件会把过程插回中间。
  return items.sort((a, b) => {
    if (a.type === 'prompt_card' || b.type === 'prompt_card') {
      return a.type === b.type ? a.order - b.order : a.type === 'prompt_card' ? 1 : -1;
    }
    return compareResponsePosition(a, b);
  });
});

/** 过程折叠区内的时序项（剔除互动卡片）。 */
const processItems = computed(() =>
  groupReadImageTools(processTimeline.value.filter(item => item.type !== 'prompt_card'), props.sessionId)
);

/** 过程折叠区之外的互动卡片（映射为卡片展示数据）。 */
const cardItems = computed<PromptCardEntry[]>(() =>
  processTimeline.value
    .filter(item => item.type === 'prompt_card' && !!item.card)
    .map(item => ({ id: item.id, responseId: item.responseId ?? undefined, card: toPromptCardData(item.card as NonNullable<ProcessTimelineItem['card']>) }))
);
const groupedCardItems = computed(() => groupChoiceQuestions(groupCommandApprovals(cardItems.value)));

/** 已决卡片默认收成一行（避免大卡片常驻页底占位），细节按需展开；待决策卡片整卡展开。 */
const expandedCardIds = ref<Record<string, boolean>>({});
const toggleCard = (id: string) => {
  expandedCardIds.value[id] = !expandedCardIds.value[id];
};
const isCardExpanded = (id: string): boolean => !!expandedCardIds.value[id];
const cardSummary = (card: PromptCardData): string => buildCardSummary(card);

/**
 * 头部行的交互样式：能展开时才是按钮，读文件这类没有详情的行不该有「可点」的视觉暗示。
 * （样式集中在此的理由同 {@link toolStatusDotClass}：模板里只保留一次类绑定，避免分支散落。）
 */
const toolRowHeaderClass = (tc: ToolCallTrace, dark: boolean): string[] => {
  const base = dark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-600';
  if (!canExpandTool(tc)) {
    return [base, 'cursor-default'];
  }
  return [base, 'cursor-pointer hover:text-lx-primary'];
};

const getToolMeta = (tc: ToolCallTrace) => resolveToolMeta({ toolName: tc.toolName, args: tc.args ?? tc.query });
const getToolCategory = (tc: ToolCallTrace): string => getToolMeta(tc).category;

/**
 * 工具执行状态 → 指示灯样式。
 * 契约 §2.3：`pending`（挂起待人工决策）与 `unknown`（状态未知）**不得**显示为成功或失败。
 */
const toolStatusDotClass = (status?: string): string => {
  switch (status) {
    case 'calling':
      
    case 'pending':
      return 'bg-amber-400 animate-pulse';
    case 'failed':
      return 'bg-red-500';

    case 'unknown':
      return 'bg-gray-400';

    default:
      return 'bg-emerald-500';
  }
};

/** 是否处于「进行中」（已请求 / 挂起待决断）——用于展示执行中占位 */
const isToolInProgress = (status?: string): boolean => status === 'calling' || status === 'pending';

const getToolTarget = (tc: ToolCallTrace): string => getToolMeta(tc).target;
const getToolLineRange = (tc: ToolCallTrace): string => getToolMeta(tc).lineRange;
const getToolDescription = (tc: ToolCallTrace): string => getToolMeta(tc).description;
const getToolDetail = (tc: ToolCallTrace): string => {
  const meta = getToolMeta(tc);
  return tc.toolName === AgentToolName.ExecuteCommand ? meta.command : meta.description;
};

/**
 * 工具 diff 统计：统一走 utils/toolDiff.ts 的 parseToolDiff（收敛原因见该模块头注释）。
 * 这里仅把「未知(null)」适配成模板约定的 undefined 形态，保持 UI 输出不变。
 * 原实现在此处用 `catch {}` 静默吞掉 result 的 JSON 解析异常，现由 parseToolDiff 统一告警。
 */
const getToolDiffStat = (tc: ToolCallTrace): { plusLines?: number; minusLines?: number } | null => {
  const stat = parseToolDiff({
    toolName: tc.toolName,
    category: tc.category,
    plusLines: tc.plusLines,
    minusLines: tc.minusLines,
    result: tc.result,
    description: tc.description,
    target: getToolTarget(tc),
    fileEdits: props.message.fileEdits,
    context: `toolCall ${tc.id}`
  });
  if (!stat) return null;
  return {
    plusLines: stat.plusLines ?? undefined,
    minusLines: stat.minusLines ?? undefined
  };
};

const cleanDisplayPath = (val?: string): string => {
  if (!val) return '';
  return val.replace(/\s*\(\+\d+\s+-\d+\)$/, '').trim();
};

const getEditFileDiffChunks = (tc: ToolCallTrace) => {
  const args = toObject(tc.query, {});
  const oldText = typeof args.oldText === 'string' ? args.oldText : '';
  const newText = typeof args.newText === 'string' ? args.newText : '';
  if (!oldText && !newText) return null;
  return { oldText, newText };
};

/**
 * 轮次是否**仍在运行**（权威判据，供「过程框展开态」与「工具条出现时机」共用）。
 *
 * <p>多轮工具调用期间会出现一个「守卫真空」：`handleToolCall` 清掉了
 * `isThinking` / `isExploring`（工具调用意味着本轮叙述告一段落），而后台 reconcile
 * 重建的行 `isComplete` 恒为 true，若此时 `turn.status` 尚未解析出来，所有既有守卫
 * 全部放行 —— 界面就会在轮次跑到一半时把过程框收起，且不再自动展开。</p>
 *
 * <p>这里补一条只看「事实」的判据：<b>只要有工具停在调用中 / 待定，轮次就没结束</b>。
 * 它不依赖 `isThinking` / `turn` 是否及时到位，因此不存在同样的真空。</p>
 */
const isTurnRunning = computed(() => {
  if (props.message.isThinking || props.message.isExploring) return true;
  if (props.message.isComplete === false) return true;
  if (props.isSending && props.isLastAssistant) return true;
  const status = String(props.turn?.status ?? '').toUpperCase();
  if (isActiveTurnStatus(status)) return true;
  return hasPendingTool(props.message.toolCalls);
});

/**
 * 是否应该收起过程框。
 *
 * <p>用户手动点过之后以用户意见为准（`processToggleOverride`）：否则一条迟到的
 * `isComplete` 跳变会把用户刚展开的过程框又收回去，等于「展开之后再也留不住」。</p>
 */
const shouldCollapseProcess = computed(() => isMessageCompleted.value && !processToggleOverride.value);

/** 终态底栏不依赖正文，只有思考内容也必须展示；须在完成判据首次求值前声明。 */
const isTerminalTurn = computed(() => props.message.cancelled === true || props.message.failed === true);

/** 该助手回答是否已完成会话生成（会话/响应结束时才展示底栏工具栏与状态） */
const isMessageCompleted = computed(() => {
  // 1~4. 权威「仍在运行」判据集中收敛在 isTurnRunning（含思考中 / 显式未完成 /
  //      全局发送中且为最新回答 / 轮次摘要活跃 / 仍有工具未收尾）。
  if (isTurnRunning.value) {
    return false;
  }
  // 5. 轮次摘要若存在且仍在活跃态，且没有本端收到的终结证据，则不算完成。
  //
  // ⚠️ 只在 **status 明确存在** 时用摘要拦截：status 为空（历史行没有轮次摘要）时不能拦 ——
  // 那会把「旧数据 / 老会话」整片挡掉（工具条与收起行为全失效）。历史行的完成性由
  // isTurnRunning 里「已无未收尾工具」放行，不需要在这里再判一次。
  const status = String(props.turn?.status ?? '').toUpperCase();
  const hasTerminalEvidence = props.message.durationMs != null
    || props.message.tokenInfo != null
    || props.message.tokens != null;
  if (status !== '' && isActiveTurnStatus(status) && !hasTerminalEvidence) {
    return false;
  }
  // 终态标记不依赖正文或轮次摘要是否已到，运行中的守卫仍须先判断。
  if (isTerminalTurn.value) {
    return true;
  }
  // 7. 其余必须真有内容或工具，否则底栏没有可挂的语义
  return !!(props.message.content || props.message.toolCalls?.length);
});

/**
 * 终结时收起整轮过程。
 *
 * <p>只在 false→true 这一次跳变上收起：若持续 watch，用户手动展开后会被立刻重新收起，
 * 等于「终结之后再也没法展开」。历史加载的气泡一开始就是 completed，不触发跳变，
 * 其展开态由 {@link isProcessExpanded} 的初值决定。</p>
 */
/**
 * 过程框的自动收起：轮次终结（且用户没手动干预过）时收起，并把逐项展开态一并重置。
 *
 * <p>⚠️ 判据必须是 {@link shouldCollapseProcess}，不能直接看 `isComplete`。
 * `isComplete` 只表示「这一条已经是权威行」（历史重建 / 已落库），不代表轮次终结 ——
 * 后台对账 rebuild 出的行恒为 true，而那一刻轮次可能还在跑（还有工具停在调用中），
 * 直接看它就会在跑到一半时把过程框收起。再叠加 {@link processToggleOverride}，
 * 用户手动展开后不再被迟到的跳变收回。</p>
 *
 * <p>只在 false→true 这一次跳变上收起：若持续 watch，用户手动展开后会被立刻重新收起。</p>
 */
watch(shouldCollapseProcess, (collapse, wasCollapse) => {
  if (!collapse || wasCollapse) return;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = undefined;
  }
  isProcessExpanded.value = false;
  expandedToolIds.value = {};
  expandedThoughtStepIds.value = {};
}, { immediate: true });

 

// formatDuration 已收敛到 utils/format.ts（原第 381-388 行）

/** 本条消息所属回答组的轮次信息（权威来源）；null = 无轮次，不伪造统计。 */
const execSummary = computed(() => props.turn ?? null);

/**
 * 是否展示本组的执行元信息（用量/耗时）。
 * 仅组尾展示一次；实时流在摘要尚未写入会话表时，用气泡自带统计即时展示。
 * 旧数据（无摘要且无自带统计）一律隐藏，不显示成 0。
 */
const showExecutionMeta = computed(() => {
  if (props.isGroupTail === false) return false;
  if (execSummary.value) return true;
  return props.message.tokenInfo != null || props.message.tokens != null || (props.message.durationMs ?? 0) > 0;
});

const displayDuration = computed(() => {
  const e = execSummary.value;
  if (e) {
    // elapsedMs 为 null（startedAt 缺失）→ 暂无统计，绝不当 0
    return formatDurationOrPlaceholder(e.elapsedMs);
  }
  // 实时流：本组摘要尚未写入会话表时，用气泡自带耗时兜底；都缺失则「暂无统计」
  return formatDurationOrPlaceholder(props.message.durationMs);
});

const tokenUsage = computed(() => resolveTokenUsage(execSummary.value, props.message));
/** 执行状态展示（仅摘要存在时展示）；进行中/失败/终态用不同配色，失败附带原因全文。 */
const execStatusMeta = computed(() => {
  const e = execSummary.value;
  if (!e) return null;
  const running = isActiveTurnStatus(e.status);
  const failed = isFailedTurnStatus(e.status);
  return {
    text: turnStatusLabel(e.status),
    running,
    failed,
    errorReason: failed ? (e.errorReason || '').trim() : ''
  };
});

const displayTime = computed(() => {
  // 「开始时间」取轮次摘要的 startedAt：历史投影给气泡的 timestamp 是 Date.now() 兜底，
  // 不是真实发送时间；有摘要就一律用权威值，用户气泡与底栏因此显示同一个时刻。
  const startedAt = props.turn?.startedAt;
  const value = startedAt ? new Date(startedAt) : new Date(props.message.timestamp);
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
});


const copyContent = () => {
  void copyContentRaw(props.message.content);
};

const handleImageClick = (url?: string) => {
  if (url) {
    window.open(url, '_blank');
  }
};
</script>

<style scoped>
/* 淡入淡出过渡 */
.context-compact-fade-enter-active,
.context-compact-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.context-compact-fade-enter-from,
.context-compact-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 高亮在循环两端都位于文字外，复位时不会闪回或滞留在右侧。 */
.context-compact-shimmer-text {
  background: linear-gradient(
    90deg,
    var(--lx-text-muted) 40%,
    var(--lx-text-primary) 50%,
    var(--lx-text-muted) 60%
  );
  background-size: 300% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: context-shimmer-text 2.2s linear infinite;
}

@keyframes context-shimmer-text {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0% 0;
  }
}

</style>
