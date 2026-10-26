<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdownDocument } from '../../utils/markdown';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import GradientText from '../common/GradientText.vue';
import MarkdownContent from './MarkdownContent';

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

const markdownDocument = computed(() => renderMarkdownDocument(props.content || '', props.isThinking));
const renderedHtml = computed(() => markdownDocument.value.html);

// 普通代码块由 Markdown 生成，事件委托可以复用同一套复制反馈。
const { copy: copyRaw } = useCopyFeedback();

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
    textSpan.textContent = t('common.copied');
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
    >
      <MarkdownContent :document="markdownDocument" :is-dark="isDark" />
    </div>
    
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
      >{{ t('chat.message.exploringShort') }}</GradientText>
    </div>
  </div>
</template>

<style scoped>
.markdown-container {
  width: 100%;
}
</style>
