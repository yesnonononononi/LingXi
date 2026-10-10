<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useTheme } from '../../composables/useTheme';
import GradientText from '../common/GradientText.vue';

const props = withDefaults(
  defineProps<{
    content?: string;
    isDark?: boolean;
    isThinking?: boolean;
    /** 过程文本需要独立样式，避免影响最终正文。 */
    processText?: boolean;
    /** 思考内容独立弱化，正文与过程叙述保持各自样式。 */
    thinkingText?: boolean;
  }>(),
  {
    content: '',
    isDark: undefined,
    isThinking: false,
    processText: false,
    thinkingText: false
  }
);

const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

const renderedHtml = computed(() => {
  return renderMarkdown(props.content || '');
});

// 剪贴板写入 + 失败告警统一走 composable（见 composables/useCopyFeedback.ts）。
// 代码块按钮位于 v-html 容器内、非 Vue 托管节点，故「已复制」文案/样式仍在此手动切换。
const { copy: copyRaw } = useCopyFeedback();

// Event delegation for copying code from any code block
const handleContainerClick = async (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  const btn = target.closest('.copy-code-btn') as HTMLElement;
  if (!btn) return;

  event.stopPropagation();
  const encoded = btn.getAttribute('data-code');
  if (!encoded) return;

  const rawCode = decodeURIComponent(encoded);
  if (!(await copyRaw(rawCode))) return;
  const textSpan = btn.querySelector('.copy-text') as HTMLElement;
  if (textSpan) {
    const originalText = textSpan.textContent;
    textSpan.textContent = '已复制';
    btn.classList.add('!text-emerald-400');
    setTimeout(() => {
      textSpan.textContent = originalText;
      btn.classList.remove('!text-emerald-400');
    }, 2000);
  }
};
</script>

<template>
  <div
    class="markdown-container markdown-stream-flow select-text"
    :class="[
      props.thinkingText ? (isDark ? 'text-zinc-400' : 'text-[#888888]') : props.processText ? (isDark ? 'text-zinc-100' : 'text-black') : (isDark ? 'text-zinc-100' : 'text-gray-800'),
      { 'is-streaming': props.isThinking }
    ]"
    @click="handleContainerClick"
  >
    <div
      v-if="renderedHtml"
      class="markdown-body"
      :class="{ 'markdown-body--process': props.processText, 'markdown-body--thinking': props.thinkingText }"
      v-html="renderedHtml"
    ></div>
    
    <!-- 空正文时用文字提示工作状态，避免光条难以辨认。 -->
    <div
      v-if="props.isThinking && !renderedHtml"
      class="flex items-center select-none"
      role="status"
    >
      <GradientText
        :colors="['#3b82f6', '#6366f1', '#a855f7', '#38bdf8', '#3b82f6']"
        :animation-speed="2.5"
        :show-border="false"
        class="text-sm font-medium tracking-wide !mx-0 !ml-0"
      >正在探索中</GradientText>
    </div>
  </div>
</template>

<style scoped>
.markdown-container {
  width: 100%;
}
</style>
