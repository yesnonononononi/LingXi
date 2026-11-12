<script setup lang="ts">
import {computed, watch} from 'vue';
import {renderMarkdownDocument} from '../../utils/markdown';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {useTheme} from '../../composables/useTheme';
import {useThinkingText} from '../../composables/useThinkingText';
import {t} from '../../i18n';
import MarkdownContent from './MarkdownContent';

const props = withDefaults(
  defineProps<{
    content?: string;
    isDark?: boolean;
    isThinking?: boolean;
    /** 过程文字只需要显现动画，不应复用正文的空内容占位。 */
    streaming?: boolean;
    /** 过程文本需要独立样式，避免影响最终正文。 */
    processText?: boolean;
    /** 思考内容独立弱化，正文与过程叙述保持各自样式。 */
    thinkingText?: boolean;
    /** 启用平滑流式吐字调度（正文与思考通用），按 32ms 逐帧平滑释放以避免网络突发分片顿挫。 */
    smoothStreaming?: boolean;
    /** 首帧携带首个未完结流式分片挂载时显式开启首包渐显；未传时按挂载是否为空判定。 */
    revealInitial?: boolean;
  }>(),
  {
    content: '',
    isDark: undefined,
    isThinking: false,
    streaming: undefined,
    processText: false,
    thinkingText: false,
    smoothStreaming: false,
    revealInitial: undefined
  }
);
const emit = defineEmits<{ 'content-rendered': [] }>();

const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);
// 初次挂载时已有内容属于快照；只有从空正文开始接收的首批文字需要显现。
const revealInitial = props.revealInitial ?? !props.content;
const streaming = computed(() => props.streaming ?? props.isThinking);
const isPaced = computed(() => (props.thinkingText || props.smoothStreaming) && streaming.value);
const displayedContent = useThinkingText(() => props.content || '', () => isPaced.value);
watch(displayedContent, () => {
  if (props.thinkingText || props.smoothStreaming) emit('content-rendered');
}, { flush: 'post' });

const markdownDocument = computed(() => renderMarkdownDocument(displayedContent.value, streaming.value));
const renderedHtml = computed(() => markdownDocument.value.html);

// 普通代码块由 Markdown 生成，事件委托可以复用同一套复制反馈。
const { copy: copyRaw } = useCopyFeedback();

const handleContainerClick = async (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  const btn = target.closest('.copy-code-btn') as HTMLElement;
  if (!btn) return;

  event.stopPropagation();
  let encoded = btn.getAttribute('data-code');
  if ((props.thinkingText && displayedContent.value !== props.content) || (props.smoothStreaming && displayedContent.value !== props.content)) {
    // 复制必须取已收到的完整代码，不能把显示游标当成消息真值。
    const container = event.currentTarget as HTMLElement;
    const index = [...container.querySelectorAll('.copy-code-btn[data-code]')].indexOf(btn);
    const template = document.createElement('template');
    template.innerHTML = renderMarkdownDocument(props.content || '', streaming.value).html;
    encoded = template.content.querySelectorAll('.copy-code-btn[data-code]')[index]?.getAttribute('data-code') ?? encoded;
  }
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
      props.thinkingText ? (isDark ? 'text-zinc-400' : 'text-[#888888]') : props.processText ? (isDark ? 'text-zinc-100' : 'text-black') : (isDark ? 'text-zinc-100' : 'text-zinc-800'),
      { 'is-streaming': props.isThinking }
    ]"
    @click="handleContainerClick"
  >
    <div
      v-if="renderedHtml"
      class="markdown-body"
      :class="{ 'markdown-body--process': props.processText, 'markdown-body--thinking': props.thinkingText }"
    >
      <MarkdownContent :document="markdownDocument" :is-dark="isDark" :streaming="streaming" :reveal-initial="revealInitial" />
    </div>
    
    <!-- 空正文时用文字提示工作状态，避免光条难以辨认。 -->
    <div
      v-if="props.isThinking && !renderedHtml"
      class="flex items-center select-none"
      role="status"
    >
      <span class="text-sm font-medium tracking-wide lx-sweep-text">{{ t('chat.message.awaitModelResponse') }}</span>
    </div>
  </div>
</template>

<style scoped>
.markdown-container {
  width: 100%;
}
</style>
