<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { ChatMessage, ThoughtStep, ToolCallTrace, SubSessionVO, ChatTurn, SubItemStatus } from '../../types/chat';
import type { ImageProcessItem } from '../../utils/readImageTools';
import { FILE_PREVIEW_KEY } from '../../types/filePreview';
import { isEditFileTool, isReadFileTool, shouldShowToolArguments, resolveToolMeta,
  extractSubAgentParams, unwrapToolResultEnvelope, TOOL_CATEGORY } from '../../utils/toolMeta';
import { toObject } from '../../utils/json';
import { isAsyncDelegation, asyncSubSessionStatus, subItemStatusDotClass } from '../../utils/asyncDelegation';
import { AgentToolName } from '../../utils/toolNames';
import { resolveToolRenderName } from '../../utils/toolDisplayNames';
import { parseToolDiff } from '../../utils/toolDiff';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useStreamStickyScroll } from '../../composables/useStreamStickyScroll';
import { t } from '../../i18n';
import GradientText from '../common/GradientText.vue';
import CollapseTransition from '../common/CollapseTransition.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ReadImageToolGroup from './ReadImageToolGroup.vue';

const props = defineProps<{
  items: ImageProcessItem[];
  message: ChatMessage;
  subSessions?: SubSessionVO[];
  sessionId?: string | number;
  isDark: boolean;
  turn?: ChatTurn | null;
}>();
const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();
const isDark = computed(() => props.isDark);
const openFilePreview = inject(FILE_PREVIEW_KEY);
const canPreviewFile = (tool: ToolCallTrace) => !!openFilePreview && (isReadFileTool(tool.toolName) || isEditFileTool(tool.toolName));
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
    const steps = props.items.flatMap(item => item.step ? [item.step] : []);
    if (!steps || steps.length === 0) return '';
    return steps.map((step) => `${step.id}:${step.content?.length ?? 0}`).join('|');
  },
  boxIds: () => {
    const steps = props.items.flatMap(item => item.step ? [item.step] : []);
    if (!steps || steps.length === 0) return [];
    return steps.map((step) => String(step.id));
  },
  // 只有还在跑的思考才从贴底开始：已定型的思考一旦展开，应当从头读，
  // 也不能被别处的增量顶到底部。
  shouldStickOnMount: (id) =>
    props.items.flatMap(item => item.step ? [item.step] : [])?.some((step) => String(step.id) === id && step.status === 'running') ?? false
});

const toggleToolCall = (id: string) => {
  expandedToolIds.value[id] = !expandedToolIds.value[id];
};

const copyToolContent = (text: string, id: string) => {
  void copyToolContentRaw(text, id);
};

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


</script>
<template>
<div class="space-y-2.5">
          <template v-for="item in props.items" :key="item.id">
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
                          <span class="text-lx-faint font-mono text-xs flex-shrink-0 select-none">
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
                          class="text-xs text-gray-400 hover:text-lx-secondary transition px-1 py-0.5 select-none flex-shrink-0 cursor-pointer"
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
</div>
</template>
