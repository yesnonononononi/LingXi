<script setup lang="ts">
/**
 * 普通工具行 renderer：头部操作条（类型图标 / 目标 / 行范围 / diff 统计）+ 展开详情卡片。
 *
 * <p>根元素与 class 与原 `ProcessDetails.vue` 的 tool 分支逐字一致；
 * 头部按钮的「箭头列恒定占位」由 `tests/toolRowIconAlignment.test.cjs` 锁定。</p>
 *
 * <p>纯逻辑（meta / diff / 状态灯 / 可展开判定 / diff 文本块）全部来自 `utils/toolRowUi.ts`，
 * 这里只做「绑定 + 本地折叠状态」。</p>
 */
import { computed, inject, ref } from 'vue';
import type { ImageProcessItem } from '../../../utils/readImageTools';
import type { ChatMessage } from '../../../types/chat';
import { TOOL_CATEGORY, isEditFileTool, isReadFileTool, unwrapToolResultEnvelope, shouldShowToolArguments } from '../../../utils/toolMeta';
import { resolveToolRenderName } from '../../../utils/toolDisplayNames';
import {
  buildEditDiffChunks,
  canExpandToolRow,
  cleanDisplayPath,
  isToolInProgress,
  resolveToolRowDiff,
  resolveToolRowMeta,
  toolRowHeaderClass,
  toolStatusDotClass,
} from '../../../utils/toolRowUi';
import { useCopyFeedback } from '../../../composables/useCopyFeedback';
import { FILE_PREVIEW_KEY } from '../../../types/filePreview';
import { t } from '../../../i18n';
import CollapseTransition from '../../common/CollapseTransition.vue';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  /** 文件预览要用的会话 id（`openFilePreview(sessionId, path)` 的入参）。 */
  sessionId?: string | number;
  /** `getToolDiffStat` 唯一用到的消息字段（权威编辑记录）。 */
  fileEdits?: ChatMessage['fileEdits'];
}>();

const tool = computed(() => props.item.tool);
const meta = computed(() => (tool.value ? resolveToolRowMeta(tool.value) : null));
const diff = computed(() => (tool.value ? resolveToolRowDiff(tool.value, props.fileEdits) : null));
const expandable = computed(() => !!tool.value && canExpandToolRow(tool.value.toolName));
const chunks = computed(() => buildEditDiffChunks(tool.value?.query));

/** 工具行的折叠状态（`:key="item.id"` 保证同 id 实例不被销毁，语义与原来的 Record 等价）。 */
const expanded = ref(false);
const toggle = (): void => {
  if (!expandable.value) return;
  expanded.value = !expanded.value;
};

const openFilePreview = inject(FILE_PREVIEW_KEY);
const canPreviewFile = computed(() => !!openFilePreview && !!tool.value
  && (isReadFileTool(tool.value.toolName) || isEditFileTool(tool.value.toolName)));

const previewTarget = (): void => {
  if (!tool.value || !canPreviewFile.value) return;
  openFilePreview?.(props.sessionId, meta.value?.target ?? '');
};

// 复制反馈：每个工具行一个实例，键仍是 `tool.id`（语义与原来单一实例 + copiedKey 等价）。
const { copiedKey, copy } = useCopyFeedback();
const copyResult = (): void => {
  if (!tool.value) return;
  copy(unwrapToolResultEnvelope(tool.value.result), tool.value.id);
};
</script>

<template>
  <!-- 4. 普通 Agent 工具调用展示 -->
  <div v-if="tool" class="w-full my-0.5">
    <!-- 普通工具调用 -->
    <div class="w-full">
      <!-- 头部操作条 (始终显示，带旋转指示箭头和类型图标) -->
      <div
        @click="toggle"
        class="flex items-center gap-1.5 text-[13px] py-0.5 transition group select-none w-full max-w-full min-w-0 overflow-hidden text-left"
        :class="toolRowHeaderClass(tool, isDark)"
        :title="cleanDisplayPath(meta?.description) || resolveToolRenderName(tool.toolName)"
      >
        <!-- 箭头列恒定占位：读文件没有详情不渲染箭头，缺了这格图标会左移一格，与可展开行的图标列对不齐 -->
        <button v-if="expandable" type="button" class="shrink-0 cursor-pointer" :aria-expanded="expanded" :aria-label="t('chat.message.viewToolDetail', { category: resolveToolRenderName(tool.toolName) })" @click.stop="toggle">
        <svg
          :class="['w-3.5 h-3.5 transition-transform duration-200 shrink-0', expanded ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-zinc-400']"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        </button>
        <span v-else class="w-3.5 h-3.5 shrink-0" aria-hidden="true"></span>
        <div class="flex-shrink-0 flex items-center">
          <svg v-if="meta?.category === TOOL_CATEGORY.READ || meta?.category === TOOL_CATEGORY.WRITE" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-zinc-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <path stroke-linecap="round" d="M8 8h8M8 12h8M8 16h4" />
          </svg>
          <svg v-else-if="meta?.category === TOOL_CATEGORY.COMMAND" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-zinc-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 9l3 3-3 3M13 15h4" />
          </svg>
          <svg v-else-if="meta?.category === TOOL_CATEGORY.THINK" class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-zinc-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="9" cy="9" r="3.5" />
            <circle cx="15" cy="9" r="3.5" />
            <circle cx="9" cy="15" r="3.5" />
            <circle cx="15" cy="15" r="3.5" />
          </svg>
          <svg v-else class="w-4 h-4" :class="isDark ? 'text-zinc-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]' : 'text-zinc-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <!-- 有目标路径/对象时（如读取/写入）：分类名 + 目标路径（读文件附行范围） -->
        <template v-if="meta?.target">
          <span class="font-normal shrink-0" :class="isDark ? 'text-zinc-100 text-glow-white font-medium' : 'text-zinc-700'">{{ resolveToolRenderName(tool.toolName) }}</span>
          <button
            type="button"
            :disabled="!canPreviewFile"
            :title="canPreviewFile ? t('chat.message.previewFile') : undefined"
            @click.stop="previewTarget()"
            class="border-b border-dotted font-mono text-[12.5px] pb-px transition-colors truncate min-w-0"
            :class="isDark ? 'border-white/30 text-zinc-200 text-glow-subtle' : 'border-zinc-400 text-zinc-700'"
          >
            {{ cleanDisplayPath(meta?.target) }}
          </button>
          <span
            v-if="meta?.lineRange"
            class="font-mono text-[11.5px] shrink-0 select-none"
            :class="isDark ? 'text-zinc-400' : 'text-zinc-400'"
          >
            {{ meta?.lineRange }}
          </span>
        </template>

        <!-- 无目标路径时（如执行命令）：描述文本与分类名称二选一（优先描述文本；缺省回退分类名） -->
        <template v-else>
          <button
            type="button"
            :disabled="!expandable"
            :aria-expanded="expanded"
            @click.stop="toggle"
            class="transition-colors truncate min-w-0 font-medium"
            :class="isDark ? 'text-[13px] text-zinc-100 text-glow-white' : 'text-[13px] text-zinc-700'"
          >
            {{ cleanDisplayPath(meta?.description) || resolveToolRenderName(tool.toolName) }}
          </button>
        </template>

        <!-- edit_file 差异行指示（完全还原图片风格：绿+N 红-M） -->
        <span
          v-if="diff"
          class="inline-flex items-center gap-1 font-mono text-[12px] font-medium leading-none shrink-0 select-none ml-1"
        >
          <span
            v-if="diff.plusLines !== undefined"
            class="text-[#088f50] dark:text-emerald-400"
          >+{{ diff.plusLines }}</span>
          <span
            v-if="diff.minusLines !== undefined"
            class="text-[#b42c3f] dark:text-rose-400"
          >-{{ diff.minusLines }}</span>
        </span>
      </div>

      <!-- 展开的工具详情卡片 (带平滑折叠动画)；读文件没有详情，见 canExpandToolRow -->
      <CollapseTransition>
        <div v-if="expandable && expanded">
          <div :class="['w-full rounded-2xl border overflow-hidden mt-1.5 shadow-xs transition-colors', isDark ? 'border-[#273043] bg-[#12161f]' : 'border-zinc-200/90 bg-white']">
            <div :class="['px-4 py-2.5 flex items-center justify-between gap-3 text-xs border-b', isDark ? 'border-zinc-800/80' : 'border-zinc-100']">
              <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden">
                <span
                  :class="[
                    'w-2 h-2 rounded-full flex-shrink-0',
                    toolStatusDotClass(tool.status)
                  ]"
                ></span>
                <span class="text-lx-faint font-mono text-xs flex-shrink-0 select-none">
                  {{ tool.workDir }}
                </span>
                <span class="font-mono text-xs text-zinc-800 dark:text-zinc-200 truncate select-text">
                  {{ cleanDisplayPath(meta?.detail) }}
                </span>
                <!-- 卡片栏中的 diff 状态指示 -->
                <span
                  v-if="diff"
                  class="inline-flex items-center gap-1 font-mono text-[12px] font-medium leading-none shrink-0 select-none ml-1"
                >
                  <span
                    v-if="diff.plusLines !== undefined"
                    class="text-[#088f50] dark:text-emerald-400"
                  >+{{ diff.plusLines }}</span>
                  <span
                    v-if="diff.minusLines !== undefined"
                    class="text-[#b42c3f] dark:text-rose-400"
                  >-{{ diff.minusLines }}</span>
                </span>
              </div>
              <button
                type="button"
                @click.stop="copyResult()"
                class="text-xs text-zinc-400 hover:text-lx-secondary transition px-1 py-0.5 select-none flex-shrink-0 cursor-pointer"
              >
                {{ copiedKey === tool.id ? t('common.copied') : t('common.copy') }}
              </button>
            </div>

            <div class="p-4">
              <!-- edit_file 工具展示增删对比块 -->
              <div v-if="isEditFileTool(tool.toolName) && chunks" class="space-y-2.5 font-mono text-xs select-text">
                <div v-if="chunks.oldText" class="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-[#b42c3f] dark:text-rose-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                  <div class="text-[11px] font-sans font-medium text-red-500/80 dark:text-red-400/80 mb-1.5 select-none flex items-center gap-1.5">
                    <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                    <span>{{ t('chat.message.diffBefore') }}</span>
                  </div>
                  {{ chunks.oldText }}
                </div>
                <div v-if="chunks.newText" class="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-[#088f50] dark:text-emerald-300 whitespace-pre-wrap overflow-x-auto max-h-48 scrollbar-thin">
                  <div class="text-[11px] font-sans font-medium text-emerald-600/80 dark:text-emerald-400/80 mb-1.5 select-none flex items-center gap-1.5">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <span>{{ t('chat.message.diffAfter') }}</span>
                  </div>
                  {{ chunks.newText }}
                </div>
              </div>
              <pre
                v-else-if="tool.result"
                :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[380px] scrollbar-thin select-text', isDark ? 'text-zinc-200' : 'text-zinc-800']"
              >{{ unwrapToolResultEnvelope(tool.result) }}</pre>
              <div v-else-if="tool.status === 'pending'" class="font-mono text-xs text-amber-500/90 flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                <span>{{ t('chat.message.awaitingDecision') }}</span>
              </div>
              <div v-else-if="isToolInProgress(tool.status)" class="font-mono text-xs text-zinc-400">{{ t('chat.message.toolInProgress') }}</div>
              <pre
                v-else-if="shouldShowToolArguments(tool.toolName) && tool.query"
                :class="['font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto select-text', isDark ? 'text-zinc-400' : 'text-zinc-600']"
              >{{ tool.query }}</pre>
              <div v-else class="text-xs text-zinc-400 font-mono">
                {{ t('chat.message.noOutput') }}
              </div>
            </div>
          </div>
        </div>
      </CollapseTransition>
    </div>
  </div>
</template>
