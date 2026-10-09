
<template>
  <div :class="['w-full py-3 px-2 sm:px-4 transition-colors', props.message.role === 'user' ? 'flex justify-end' : 'flex justify-start']">
    
    <!-- 1. 用户消息展示样式 (匹配左图：无头像，柔和浅蓝背景圆角气泡，下方展示时间与复制图标) -->
    <div v-if="props.message.role === 'user'" class="flex flex-col items-end max-w-2xl group">
      <!-- 气泡内容 -->
      <div class="relative flex items-center gap-2">
        <!-- 报错标识已移除：失败是轮次的属性，由回答组统一渲染（turn.status=FAILED + errorReason） -->
        <div
          :class="[
            'rounded-[18px] text-sm leading-relaxed whitespace-pre-wrap transition-colors break-words overflow-hidden',
            props.message.imageUrl ? 'p-2' : 'px-4 py-2.5',
            isDark ? 'bg-zinc-800 text-zinc-100 border border-white/[0.08] shadow-xs' : 'bg-[#edf3fc] text-gray-800'
          ]"
        >
          <div v-if="props.message.imageUrl" class="mb-2 max-w-sm rounded-xl overflow-hidden border border-black/10 dark:border-white/10">
            <img
              :src="props.message.imageUrl"
              alt="用户上传图片"
              class="max-h-64 w-auto object-contain rounded-xl cursor-pointer hover:opacity-95 transition"
              @click="handleImageClick(props.message.imageUrl)"
            />
          </div>
          <div :class="props.message.imageUrl ? 'px-2 pb-1' : ''">
            {{ props.message.content }}
          </div>
        </div>
      </div>

      <!-- 气泡下方时间与复制图标 (完全匹配左图) -->
      <div class="flex items-center gap-2 mt-1.5 text-xs text-gray-400 dark:text-zinc-500 pr-1 select-none">
        <span>{{ displayTime }}</span>
        <button
          @click="copyContent"
          class="hover:text-gray-600 dark:hover:text-zinc-200 transition p-0.5"
          :title="copied ? '已复制' : '复制内容'"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
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
            <!-- 1. 思维链思考内容 (深度思考 可折叠，亮白发光) -->
            <div v-if="item.type === 'thought' && item.step" class="text-xs space-y-1">
              <button
                type="button"
                @click="toggleThoughtStep(item.step.id, item.step)"
                class="font-medium flex items-center gap-1.5 cursor-pointer transition select-none py-0.5 text-left"
                :class="item.step.status === 'running'
                  ? (isDark ? 'text-white text-glow-white animate-glow-pulse' : 'text-sky-600 animate-pulse')
                  : (isDark ? 'text-zinc-100 text-glow-white hover:text-white' : 'text-sky-600 hover:text-sky-700')"
              >
                <svg
                  :class="['w-3 h-3 transition-transform duration-200 shrink-0', isThoughtStepExpanded(item.step) ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-gray-400']"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                <span class="tracking-wide">{{ formatThoughtTitle(item.step.title) }}</span>
                <span
                  v-if="item.step.status === 'running'"
                  :class="[
                    'w-1.5 h-1.5 rounded-full animate-ping',
                    isDark ? 'bg-white shadow-[0_0_8px_#ffffff]' : 'bg-blue-600 shadow-[0_0_6px_rgba(37,99,235,0.4)]'
                  ]"
                ></span>
              </button>

              <!-- 思考内容正文：带固定高度上限与滚动条限制的思考框，防止无限制向下叠加覆盖页面视图 -->
              <CollapseTransition>
                <div v-if="isThoughtStepExpanded(item.step) && item.step.content">
                  <div
                    :ref="(el) => item.step && setThinkingBoxRef(item.step.id, el)"
                    :class="[
                      'my-1.5 ml-4.5 rounded-xl border p-3 max-h-60 overflow-y-auto scrollbar-thin transition-colors select-text',
                      isDark
                        ? 'bg-zinc-900/60 border-white/10 text-zinc-100 shadow-inner'
                        : 'bg-indigo-50/40 border-indigo-100 text-slate-700'
                    ]"
                  >
                    <div
                      class="stream-thinking-content thinking-text whitespace-pre-wrap"
                      :class="[
                        isDark ? 'text-zinc-300' : 'text-slate-600',
                        { 'is-running': item.step.status === 'running' }
                      ]"
                    >
                      {{ item.step.content }}
                    </div>
                  </div>
                </div>
              </CollapseTransition>
            </div>

            <!-- 中间叙述只在展开过程时展示，避免与正文混淆。 -->
            <div
              v-else-if="item.type === 'intermediate_ai' && item.message"
              class="text-xs"
            >
              <div
                v-if="item.message.text"
                class="pl-4.5 select-text"
              >
                <MarkdownRenderer
                  :content="item.message.text"
                  :is-dark="isDark"
                  :muted="true"
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
                    <span class="font-medium">团队协作</span>
                    <span :class="['px-1.5 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap', props.isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700']">
                      {{ item.subAgents.length }} 成员正在协作
                    </span>
                  </div>
                  <p class="text-[11px] text-gray-400 whitespace-nowrap">轨迹与标签已在右侧图示面板铺开</p>
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
                  :title="`切换查看 ${tc.subAgentName || `Agent #${tc.displayIndex || idx + 1}`} 的独立会话轨迹`"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="toolStatusDotClass(tc.status)"></span>
                  <span class="truncate max-w-28">{{ tc.subAgentName || `Agent #${tc.displayIndex || idx + 1}` }}</span>
                  <span class="text-[10px] opacity-60 shrink-0">#{{ tc.displayIndex ?? (idx + 1) }}</span>
                </button>
              </div>
            </div>

            <!-- 4. 普通 Agent 工具调用展示 -->
            <div v-else-if="item.type === 'tool' && item.tool" class="w-full my-0.5">
              <!-- 普通工具调用 -->
              <div class="w-full">
                <!-- 头部操作条 (始终显示，带旋转指示箭头和类型图标) -->
                <div
                  @click="canExpandTool(item.tool) && toggleToolCall(item.tool.id)"
                  class="flex items-center gap-1.5 text-[13px] py-0.5 transition group select-none w-full max-w-full min-w-0 overflow-hidden text-left"
                  :class="toolRowHeaderClass(item.tool, isDark)"
                  :title="cleanDisplayPath(getToolDescription(item.tool)) || getToolCategory(item.tool)"
                >
                  <button v-if="canExpandTool(item.tool)" type="button" class="shrink-0 cursor-pointer" :aria-expanded="!!expandedToolIds[item.tool.id]" :aria-label="`查看${getToolCategory(item.tool)}详情`" @click.stop="toggleToolCall(item.tool.id)">
                  <svg
                    :class="['w-3.5 h-3.5 transition-transform duration-200 shrink-0', expandedToolIds[item.tool.id] ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-gray-400']"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                  </button>
                  <div class="flex-shrink-0 flex items-center">
                    <svg v-if="getToolCategory(item.tool) === '读取' || getToolCategory(item.tool) === '写入'" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="4" y="3" width="16" height="18" rx="2" />
                      <path stroke-linecap="round" d="M8 8h8M8 12h8M8 16h4" />
                    </svg>
                    <svg v-else-if="getToolCategory(item.tool) === '执行命令'" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <rect x="3" y="4" width="18" height="16" rx="3" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M7 9l3 3-3 3M13 15h4" />
                    </svg>
                    <svg v-else-if="getToolCategory(item.tool) === '思考'" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-gray-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
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
                    <span class="font-normal shrink-0" :class="isDark ? 'text-zinc-100 text-glow-white font-medium' : 'text-gray-700'">{{ getToolCategory(item.tool) }}</span>
                    <button
                      type="button"
                      :disabled="!canPreviewFile(item.tool)"
                      :title="canPreviewFile(item.tool) ? '预览文件' : undefined"
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
                      class="transition-colors text-[13px] truncate min-w-0"
                      :class="isDark ? 'text-zinc-100 text-glow-white font-medium' : 'text-gray-700 font-medium'"
                    >
                      {{ cleanDisplayPath(getToolDescription(item.tool)) || getToolCategory(item.tool) }}
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
                          @click.stop="copyToolContent(item.tool.result ?? '', item.tool.id)"
                          class="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition px-1 py-0.5 select-none flex-shrink-0 cursor-pointer"
                        >
                          {{ toolCopiedId === item.tool.id ? '已复制' : '复制' }}
                        </button>
                      </div>

                      <div class="p-4">
                        <!-- edit_file 工具展示增删对比块 -->
                        <div v-if="isEditFileToolCall(item.tool.toolName) && getEditFileDiffChunks(item.tool)" class="space-y-2.5 font-mono text-xs select-text">
                          <div v-if="getEditFileDiffChunks(item.tool)!.oldText" class="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-[#b42c3f] dark:text-rose-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                            <div class="text-[11px] font-sans font-medium text-red-500/80 dark:text-red-400/80 mb-1.5 select-none flex items-center gap-1.5">
                              <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                              <span>- 变更前 (oldText)</span>
                            </div>
                            {{ getEditFileDiffChunks(item.tool)!.oldText }}
                          </div>
                          <div v-if="getEditFileDiffChunks(item.tool)!.newText" class="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-[#088f50] dark:text-emerald-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                            <div class="text-[11px] font-sans font-medium text-emerald-600/80 dark:text-emerald-400/80 mb-1.5 select-none flex items-center gap-1.5">
                              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                              <span>+ 变更后 (newText)</span>
                            </div>
                            {{ getEditFileDiffChunks(item.tool)!.newText }}
                          </div>
                        </div>
                        <pre
                          v-else-if="item.tool.result"
                          :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[380px] scrollbar-thin select-text', isDark ? 'text-gray-200' : 'text-gray-800']"
                        >{{ item.tool.result }}</pre>
                        <div v-else-if="item.tool.status === 'pending'" class="font-mono text-xs text-amber-500/90 flex items-center gap-2">
                          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                          <span>等待人工决策（审批卡片在过程区之外）</span>
                        </div>
                        <div v-else-if="isToolInProgress(item.tool.status)" class="font-mono text-xs text-amber-500/80 animate-pulse flex items-center gap-2">
                          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                          <span>正在执行中...</span>
                        </div>
                        <pre
                          v-else-if="shouldShowToolArguments(item.tool.toolName) && item.tool.query"
                          :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto select-text', isDark ? 'text-gray-400' : 'text-gray-600']"
                        >{{ item.tool.query }}</pre>
                        <div v-else class="text-xs text-gray-400 font-mono">
                          (暂无输出)
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
              正在探索中...
            </GradientText>
          </div>
        </div>
      </div>
    </CollapseTransition>

        <!-- 细横线分割条 -->
        <div v-if="!props.message.isExploring" class="border-b border-gray-200/70 dark:border-gray-800/80 w-full mt-2 mb-2.5"></div>
      </div>

      <!-- 统一互动卡片：PLAN / CHOICE / COMMAND 三类 PROMISE 卡片（含 DELEGATION / UNAVAILABLE）。
           渲染在过程折叠区之外，作为一等时间线项，确保用户可操作项不会被吞进折叠框。 -->
      <template v-for="entry in cardItems" :key="entry.id">
        <!-- 待决策卡片整卡展开（要按键）；已决卡片默认收成一行，细节按需展开 -->
        <div v-if="!entry.card.pending" class="w-full">
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
              class="w-3.5 h-3.5 shrink-0"
              :class="isDark ? 'text-zinc-400' : 'text-gray-500'"
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

      <!-- 上下文压缩中扫光提示条 (对应 ContextUpdateEvent SQUEEZE_STARTED，收到 SQUEEZE_COMPLETED 自动消失) -->
      <transition name="context-compact-fade">
        <div
          v-if="props.message.isCompressingContext"
          class="w-full my-3 py-1 flex items-center gap-3 select-none relative overflow-hidden context-compact-bar"
          :title="props.message.contextUsage?.tokenCount ? `当前上下文：${props.message.contextUsage.tokenCount} / ${props.message.contextUsage.maxTokens || 0} tokens` : '正在压缩上下文'"
        >
          <!-- 左侧水平细线 (自动撑满左侧) -->
          <div class="flex-1 h-[1px] bg-gray-200 dark:bg-gray-700/60"></div>

          <!-- 中间指示内容：带折角便签图标 + 正在压缩上下文 -->
          <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 font-normal shrink-0">
            <!-- 小图标：对齐用户截图便签本文档折角图标 -->
            <svg class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <span class="context-compact-shimmer-text">正在压缩上下文</span>
          </div>

          <!-- 右侧水平细线 (左长右短精确对齐截图) -->
          <div class="w-16 sm:w-28 h-[1px] bg-gray-200 dark:bg-gray-700/60"></div>

          <!-- 从左到右扫光光斑层 (Light beam sweep) -->
          <div class="pointer-events-none absolute inset-0 overflow-hidden">
            <div class="context-compact-beam"></div>
          </div>
        </div>
      </transition>

      <!-- 协作式暂停 / 挂起等待提示条 -->
      <transition name="context-compact-fade">
        <div
          v-if="props.message.isSuspended"
          class="w-full my-2.5 px-3.5 py-2.5 rounded-2xl border flex items-center justify-between gap-3 text-xs select-none transition-colors"
          :class="isDark ? 'bg-amber-950/40 border-amber-800/60 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'"
        >
          <div class="flex items-center gap-2">
            <span class="relative flex h-2 w-2">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <span class="font-medium">当前轮次已挂起，等待人工决策或继续操作</span>
          </div>
          <button
            type="button"
            @click="emit('resume', props.sessionId)"
            class="px-3 py-1 rounded-xl text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition cursor-pointer shadow-xs shrink-0"
          >
            恢复执行
          </button>
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
          :title="copied ? '已复制' : '复制回答'"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>


        <!-- 执行状态（仅回答组有摘要时展示；进行中/失败/终态不同配色，失败附带原因全文 title） -->
        <div v-if="execStatusMeta" class="flex flex-1 whitespace-nowrap items-center gap-1" :title="execStatusMeta.errorReason">
          <span
            :class="[
              'w-1.5 h-1.5 rounded-full shrink-0',
              execStatusMeta.failed ? 'bg-red-500' : execStatusMeta.running ? 'bg-amber-400 animate-pulse' : 'bg-gray-500'
            ]"
          ></span>
          <span :class="execStatusMeta.failed ? (isDark ? 'text-red-400' : 'text-red-600') : ''">{{ execStatusMeta.text }}</span>
          <span
            v-if="execStatusMeta.errorReason"
            class="text-red-500/90 truncate max-w-[24rem] cursor-help"
            :title="execStatusMeta.errorReason"
          >：{{ execStatusMeta.errorReason }}</span>
        </div>

        <!-- 模型（模型名为空时隐藏该整项） -->
        <div v-if="execModelLabel" class="flex flex-1 whitespace-nowrap items-center gap-1" :title="`执行模型：${execModelLabel}`">
          <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span>{{ execModelLabel }}</span>
        </div>

        <!-- 用量统计（组尾展示一次；无摘要且无自带统计时隐藏，绝不显示成 0） -->
        <div v-if="showExecutionMeta" class="flex flex-1 whitespace-nowrap items-center gap-1 cursor-help" :title="tokenTooltip">
          <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
          <span>用量 {{ displayTokens }}</span>
        </div>

        <!-- 耗时统计（组尾展示一次；标注「总历时包含等待时间」） -->
        <div v-if="showExecutionMeta" class="flex flex-1 whitespace-nowrap items-center gap-1">
          <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>用时 {{ displayDuration }}</span>
        </div>

        <!-- 时间戳 -->
        <span>{{ displayTime }}</span>
      </div>
    </div>


  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject } from 'vue';
import { FILE_PREVIEW_KEY } from '../../types/filePreview';
import type { ChatMessage, ThoughtStep, ToolCallTrace, SubSessionVO, ProcessTimelineItem, ChatTurn, PromptCardData } from '../../types/chat';
import { toPromptCardData, buildCardSummary } from '../../utils/toolCallCard';
import { cardDotClass, cardKindIconPath, resolveCardTone } from '../../utils/cardUi';
import {
  isEditFileTool,
  isReadFileTool,
  shouldShowToolArguments,
  isSubAgentTool,
  resolveToolMeta,
  extractSubAgentParams,
} from '../../utils/toolMeta';
import { toObject } from '../../utils/json';
import { AgentToolName } from '../../utils/toolNames';
import { isActiveTurnStatus, isFailedTurnStatus, turnStatusLabel } from '../../utils/turnStatus';
import { formatDurationOrPlaceholder } from '../../utils/format';
import { parseToolDiff } from '../../utils/toolDiff';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useTheme } from '../../composables/useTheme';
import GradientText from '../common/GradientText.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import PromptCard from './PromptCard.vue';
import CollapseTransition from '../common/CollapseTransition.vue';

const props = defineProps<{
  message: ChatMessage;
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
}>();

const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);
const openFilePreview = inject(FILE_PREVIEW_KEY);
const canPreviewFile = (tool: ToolCallTrace) => !!openFilePreview && (isReadFileTool(tool.toolName) || isEditFileTool(tool.toolName));

const emit = defineEmits<{
  (e: 'selectSubSession', id: string | number): void;
  (e: 'resume', sessionId?: string | number): void;
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
  if (!title) return '深度思考';
  const t = title.trim();
  if (t === 'Thought for' || t === 'Thought' || t === '思考过程' || t === '思考' || t.toLowerCase() === 'thought for') {
    return '深度思考';
  }
  return t;
};

// 思考内容展开框 DOM 引用与流式输出自动贴底滚动
const thinkingBoxRefs = ref<Record<string, HTMLElement | null>>({});
const setThinkingBoxRef = (stepId: string, el: unknown) => {
  if (el) {
    thinkingBoxRefs.value[stepId] = el as HTMLElement;
  } else {
    delete thinkingBoxRefs.value[stepId];
  }
};

const runningThoughtState = computed(() => {
  if (props.message.isComplete) return '';
  const runningStep = props.message.thoughtSteps?.find(s => s.status === 'running');
  if (!runningStep) return '';
  return `${runningStep.id}:${runningStep.content?.length || 0}`;
});

watch(
  runningThoughtState,
  () => {
    const runningStep = props.message.thoughtSteps?.find(s => s.status === 'running');
    if (!runningStep) return;
    const box = thinkingBoxRefs.value[runningStep.id];
    if (!box) return;
    const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (isNearBottom) {
      box.scrollTop = box.scrollHeight;
    }
  },
  { flush: 'post' }
);

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
    return props.message.content ? '生成中...' : '思考中...';
  }
  const toolCount = props.message.toolCalls?.length || 0;
  const hasThoughts = !!(props.message.thoughtSteps?.length);

  if (hasThoughts && toolCount > 0) {
    return `已思考并调用 ${toolCount} 个工具`;
  }
  if (toolCount > 0) {
    return `已调用 ${toolCount} 个工具`;
  }
  if (hasThoughts) {
    return '已思考';
  }
  return '执行过程';
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
      || (agentId ? `Agent #${agentId}` : `子代理 #${displayIndex}`);

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
        message: im
      });
    });
  }

  // 3. SubAgent 协同条（按首个子会话时间线位置插入）
  if (subAgentToolCalls.value.length > 0) {
    const firstSubOrder = subAgentToolCalls.value.reduce(
      (min, tc) => Math.min(min, tc.order ?? 9999),
      subAgentToolCalls.value[0]?.order ?? 5
    );
    items.push({
      id: 'sub-agents-banner',
      type: 'sub_agent',
      order: firstSubOrder,
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
        tool: tc
      });
    });
  }

  // 5. 互动卡片（PLAN / CHOICE / COMMAND 三类 PROMISE 卡片）：参与同一时序集合，
  //    但模板里被分离到过程折叠区之外渲染 —— 用户可操作项不能被吞进「已思考并调用工具」大框。
  if (props.message.promptCards?.length) {
    props.message.promptCards.forEach((card, idx) => {
      const toolOrder = props.message.toolCalls?.find(tc => String(tc.id) === String(card.id))?.order;
      items.push({
        id: `card-${card.id ?? idx}`,
        type: 'prompt_card',
        order: toolOrder ?? (CARD_ORDER_BASE + idx),
        card
      });
    });
  }

  // 按 order 升序排列，形成真实的时序执行轨迹（新 thinking 步骤在列表底部动态追加）
  return items.sort((a, b) => a.order - b.order);
});

/** 过程折叠区内的时序项（剔除互动卡片）。 */
const processItems = computed<ProcessTimelineItem[]>(() =>
  processTimeline.value.filter(item => item.type !== 'prompt_card')
);

/** 过程折叠区之外的互动卡片（映射为卡片展示数据）。 */
const cardItems = computed<Array<{ id: string; card: PromptCardData }>>(() =>
  processTimeline.value
    .filter(item => item.type === 'prompt_card' && !!item.card)
    .map(item => ({ id: item.id, card: toPromptCardData(item.card as NonNullable<ProcessTimelineItem['card']>) }))
);

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
  return [base, dark ? 'cursor-pointer hover:text-white' : 'cursor-pointer hover:text-gray-900'];
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
  // 6. 必须有回复内容、工具调用或报错信息之一
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

/** token 数量展示：≥1000 显示 `1.2K tok`，否则 `123 tok`。 */
const formatTokenCount = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K ` : `${n} `);

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


const displayTokens = computed(() => {
  const e = execSummary.value;
  if (e) {
    // totalTokens 缺失时用 input+output 兜底（两者都非 null 才相加）；仍为 null → 暂无统计
    const total = e.totalTokens != null
      ? e.totalTokens
      : (e.inputTokens != null && e.outputTokens != null ? e.inputTokens + e.outputTokens : null);
    return total == null ? '暂无统计' : formatTokenCount(total);
  }
  // 实时流：气泡自带统计（本组摘要尚未写入会话表时的即时展示）
  const own = props.message.tokenInfo?.totalTokenCount ?? props.message.tokens;
  return own != null ? formatTokenCount(own) : '暂无统计';
});

const tokenTooltip = computed(() => {
  const e = execSummary.value;
  if (e) {
    const fmt = (n?: number | null) => (n == null ? '暂无' : String(n));
    if (e.inputTokens == null && e.outputTokens == null && e.totalTokens == null) return '暂无统计';
    return `输入: ${fmt(e.inputTokens)} | 输出: ${fmt(e.outputTokens)} | 总计: ${fmt(e.totalTokens)}`;
  }
  const info = props.message.tokenInfo;
  if (info) {
    const fmt = (n?: number | null) => (n == null ? '暂无' : String(n));
    return `输入: ${fmt(info.inputTokenCount)} | 输出: ${fmt(info.outputTokenCount)} | 总计: ${fmt(info.totalTokenCount)}`;
  }
  const t = props.message.tokens;
  return t != null ? `总用量: ${t} tokens` : '暂无统计';
});

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

/** 模型展示（模型名为空时隐藏模型项；提供方可选）。 */
const execModelLabel = computed(() => {
  const e = execSummary.value;
  if (!e) return '';
  const name = (e.modelName || '').trim();
  if (!name) return '';
  const provider = (e.modelProvider || '').trim();
  return provider ? `${name} · ${provider}` : name;
});

const displayTime = computed(() => {
  return new Date(props.message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
.thinking-text {
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.85;
  letter-spacing: 0.01em;
  overflow-wrap: anywhere;
  text-shadow: none;
}

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

/* 文字从左到右扫光效果 */
.context-compact-shimmer-text {
  background: linear-gradient(
    90deg,
    #6b7280 0%,
    #6b7280 25%,
    #111827 50%,
    #6b7280 75%,
    #6b7280 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: context-shimmer-text 2s linear infinite;
}

:deep(.dark) .context-compact-shimmer-text,
.dark .context-compact-shimmer-text {
  background: linear-gradient(
    90deg,
    #9ca3af 0%,
    #9ca3af 25%,
    #ffffff 50%,
    #9ca3af 75%,
    #9ca3af 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: context-shimmer-text 2s linear infinite;
}

@keyframes context-shimmer-text {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

/* 贯穿全宽的从左到右扫光束 (Light beam sweep) */
.context-compact-beam {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 35%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0) 10%,
    rgba(255, 255, 255, 0.8) 50%,
    rgba(255, 255, 255, 0) 90%,
    transparent 100%
  );
  mix-blend-mode: overlay;
  animation: context-beam-sweep 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

:deep(.dark) .context-compact-beam,
.dark .context-compact-beam {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0) 10%,
    rgba(255, 255, 255, 0.4) 50%,
    rgba(255, 255, 255, 0) 90%,
    transparent 100%
  );
  mix-blend-mode: screen;
}

@keyframes context-beam-sweep {
  0% {
    transform: translateX(-150%);
  }
  100% {
    transform: translateX(350%);
  }
}
</style>
