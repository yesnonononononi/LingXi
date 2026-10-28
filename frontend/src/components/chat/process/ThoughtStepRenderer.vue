<script setup lang="ts">
/**
 * 思考步骤 renderer：标题折叠 + 流式贴底框 + 回到底部入口。
 *
 * <p>根元素与 class 与原 `ProcessDetails.vue` 的 thought 分支逐字一致（DOM 契约）。</p>
 *
 * <p>折叠状态改为本地 `ref`：`ProcessDetails` 用 `:key="item.id"` 保证同 id 实例不被销毁，
 * 因此「按 id 键控」的语义与原来的 `Record<id, boolean>` 等价。</p>
 */
import { computed, ref } from 'vue';
import type { ImageProcessItem } from '../../../utils/readImageTools';
import type { ThoughtStep } from '../../../types/chat';
import { formatThoughtTitle } from '../../../utils/toolRowUi';
import { t } from '../../../i18n';
import GradientText from '../../common/GradientText.vue';
import CollapseTransition from '../../common/CollapseTransition.vue';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import type { ThinkingScrollApi } from './processRenderers';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  /** 轮次是否仍在运行（`turn.status === 'RUNNING'`，无 turn 时取 `isComplete !== true`）。 */
  isRunningTurn: boolean;
  /** 消息原始完成标记：`false` 才允许「运行中的思考默认展开」（`undefined` 不展开）。 */
  isMessageComplete?: boolean;
  messageIsSuspended: boolean;
  scroll: ThinkingScrollApi;
}>();

/** 注册表只在 `item.step` 存在时匹配到本 renderer，故模板用 `v-if="step"` 收窄。 */
const step = computed<ThoughtStep | undefined>(() => props.item.step);

/** 用户是否手动改过折叠：一旦点过就以用户选择为准。 */
const userExpanded = ref<boolean | undefined>(undefined);

/** 未手动操作时的默认态：仍在运行的思考、且消息明确未完成 → 展开。 */
const defaultExpanded = computed(() => !!step.value && step.value.status === 'running'
  && props.isMessageComplete === false);

const isExpanded = computed(() => userExpanded.value ?? defaultExpanded.value);

/** 标题动画（GradientText）只在「跑步中 + 未挂起 + 轮次在跑」时开启。 */
const isAnimating = computed(() => !!step.value && step.value.status === 'running'
  && !props.messageIsSuspended && props.isRunningTurn);

const toggle = (): void => {
  userExpanded.value = !isExpanded.value;
};
</script>

<template>
  <div v-if="step" class="text-[13px] space-y-1">
    <button
      type="button"
      @click="toggle"
      class="font-medium flex items-center gap-1.5 cursor-pointer transition select-none py-0.5 text-left"
      :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'"
    >
      <svg
        :class="['w-3 h-3 transition-transform duration-200 shrink-0', isExpanded ? 'rotate-90' : '', isDark ? 'text-zinc-300 drop-shadow-[0_0_4px_rgba(255,255,255,0.4)]' : 'text-zinc-400']"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      <GradientText
        v-if="isAnimating"
        :colors="['#40ffaa', '#4079ff', '#40ffaa', '#4079ff', '#40ffaa']"
        :animation-speed="3"
        :show-border="false"
        class="tracking-wide !p-0"
      >{{ formatThoughtTitle(step.title) }}</GradientText>
      <span v-else class="tracking-wide">{{ formatThoughtTitle(step.title) }}</span>
    </button>

    <!-- 长思考保留滚动上限，避免撑满会话。 -->
    <CollapseTransition>
      <div v-if="isExpanded && step.content" class="relative">
        <div
          :ref="(el) => step && scroll.setBoxRef(step.id, el)"
          :class="[
            'thinking-content my-2 ml-1 border-l-[3px] pl-4 pr-2 max-h-72 overflow-y-auto scrollbar-thin select-text',
            isDark ? 'border-zinc-700' : 'border-zinc-200'
          ]"
          @scroll="step && scroll.handleScroll(step.id, $event)"
        >
          <MarkdownRenderer :content="step.content" :is-dark="isDark" :thinking-text="true" />
        </div>
        <!-- 用户上滑看前文后，新分片不再抢滚动位置；给一个一键回到底部的入口。
             只在仍在流式的思考上出现 —— 已定型的内容停在顶部是正常的，不该催人回底部。 -->
        <button
          v-if="step.status === 'running' && !scroll.isFollowing(step.id)"
          type="button"
          @click="scroll.scrollToBottom(step.id)"
          :class="[
            'absolute bottom-2 right-2 flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] leading-none shadow-sm transition-colors cursor-pointer',
            isDark
              ? 'border-white/15 bg-[#1b2130]/90 text-zinc-300 hover:text-zinc-100'
              : 'border-zinc-200 bg-white/95 text-zinc-500 hover:text-zinc-800'
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
</template>
