<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { useTheme } from '../../composables/useTheme';

const props = withDefaults(
  defineProps<{
    content?: string;
    isDark?: boolean;
    isThinking?: boolean;
    /**
     * 弱化档：中间叙述（过程文本）用它，字号与颜色都降一级，与正文明确分层。
     *
     * <p><b>必须由本组件承担</b>：{@code .markdown-body} 的 {@code font-size} 是绝对值，
     * 父级加 {@code text-xs} 压不下去；颜色虽可继承，但本容器默认写死了正文色。</p>
     */
    muted?: boolean;
  }>(),
  {
    content: '',
    isDark: undefined,
    isThinking: false,
    muted: false
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
      isDark ? 'text-zinc-100' : 'text-gray-800',
      { 'is-streaming': props.isThinking },
      props.muted && (isDark ? 'text-zinc-400' : 'text-slate-600')
    ]"
    @click="handleContainerClick"
  >
    <div
      v-if="renderedHtml"
      class="markdown-body"
      :class="{ 'markdown-body--muted': props.muted }"
      v-html="renderedHtml"
    ></div>
    
    <!-- 打字思考光标：仅在尚未生成正文时作为占位显示，正文流式生成后由末尾文本伪元素内联跟进，避免孤立空行 -->
    <span v-if="props.isThinking && !renderedHtml" class="typing-cursor inline-block ml-0.5"></span>
  </div>
</template>

<style scoped>
.markdown-container {
  width: 100%;
}
</style>
