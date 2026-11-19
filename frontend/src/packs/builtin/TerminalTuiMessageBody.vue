<script setup lang="ts">
import {computed, ref} from 'vue';
import type {ChatMessage} from '../../types/chat';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.vue';
import MessageImage from '../../components/chat/MessageImage.vue';
import {resolveApiUrl} from '../../utils/apiConfig';
import {t} from '../../i18n';

const props = defineProps<{
  message: ChatMessage;
  isDark: boolean;
  isThinking: boolean;
}>();

const rawMode = ref(false);
const isStreaming = computed(() => Boolean(props.isThinking && !props.message.isComplete && !props.message.isSuspended));
const revealInitial = computed(() => isStreaming.value && !props.message.turnState?.bodyPromotedFromProcess);
const charCount = computed(() => (props.message.content || '').length);
const lineCount = computed(() => (props.message.content ? props.message.content.split('\n').length : 0));
</script>

<!--
  星轨智核流（内置 Slot 极限）：正文按「进程 stdout」呈现。
  重点是阅读节奏而非装饰：等宽正文 + 左侧 gutter + 一行遥测脚注，
  流式时顶部走一条扫描线，避免满屏脉冲把阅读区变成一个发光玩具。
-->
<template>
  <div
    class="tui-stream relative w-full overflow-hidden"
    :style="{
      backgroundColor: 'var(--lx-surface)',
      borderColor: isStreaming ? 'color-mix(in srgb, var(--lx-info) 45%, var(--lx-border-default))' : 'var(--lx-border-subtle)',
    }"
  >
    <!-- 流式扫描线：只在生成时出现，一条 1px 的横向游走高光 -->
    <div v-if="isStreaming" class="tui-scan" aria-hidden="true" />

    <div
      class="tui-bar flex items-center justify-between gap-2 px-3 py-1"
      :style="{ borderColor: 'var(--lx-border-subtle)', backgroundColor: 'var(--lx-surface-sunken)' }"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="tui-tag truncate" :style="{ color: 'var(--lx-text-muted)' }">
          agent@lingxi<span :style="{ color: 'var(--lx-text-faint)' }">:~/out</span>
        </span>
        <span
          class="tui-tag tui-badge"
          :style="{
            color: isStreaming ? 'var(--lx-info)' : 'var(--lx-success)',
            borderColor: isStreaming ? 'color-mix(in srgb, var(--lx-info) 55%, transparent)' : 'color-mix(in srgb, var(--lx-success) 45%, transparent)',
          }"
        >{{ isStreaming ? 'streaming' : 'done' }}</span>
      </div>

      <button
        v-if="props.message.content"
        type="button"
        class="tui-btn"
        :data-active="rawMode ? 'true' : 'false'"
        @click="rawMode = !rawMode"
      >{{ rawMode ? 'rendered' : 'raw' }}</button>
    </div>

    <div class="tui-gutter px-3 py-2.5">
      <pre
        v-if="rawMode && props.message.content"
        class="tui-code max-h-[460px] overflow-auto whitespace-pre-wrap break-words"
        :style="{ color: 'var(--lx-code-text)' }"
      >{{ props.message.content }}</pre>
      <MarkdownRenderer
        v-else-if="props.message.content || !props.message.responseImageUrls?.length"
        :content="props.message.content"
        :is-dark="props.isDark"
        :is-thinking="props.isThinking"
        :streaming="isStreaming"
        :smooth-streaming="true"
        :reveal-initial="revealInitial"
      />

      <div v-if="props.message.responseImageUrls?.length" class="mt-3 flex flex-wrap gap-3" data-testid="response-images">
        <MessageImage
          v-for="(url, index) in props.message.responseImageUrls"
          :key="url"
          :src="url.startsWith('/') ? resolveApiUrl(url) : url"
          :alt="t('chat.message.generatedImageIndex', {index: index + 1})"
          :is-dark="props.isDark"
        />
      </div>
    </div>

    <div class="tui-foot flex items-center gap-1 px-3 py-1" :style="{ borderColor: 'var(--lx-border-subtle)', color: 'var(--lx-text-faint)' }">
      <span :style="{ color: 'var(--lx-text-muted)' }">wc</span>
      <span class="tui-sep">·</span>{{ lineCount }} lines
      <span class="tui-sep">·</span>{{ charCount }} chars
      <span v-if="isStreaming" class="tui-caret" aria-hidden="true">▊</span>
    </div>
  </div>
</template>

<style scoped>
.tui-stream {
  border: 1px solid;
  border-radius: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.tui-bar { border-bottom: 1px solid; }
.tui-tag { font-size: 10px; letter-spacing: 0.06em; }
.tui-badge { padding: 0 5px; border: 1px solid; border-radius: 2px; line-height: 14px; }
.tui-sep { opacity: 0.45; padding-inline: 3px; }

.tui-btn {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--lx-text-muted);
  background: transparent;
  border: 1px solid var(--lx-border-subtle);
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.tui-btn:hover { color: var(--lx-accent); border-color: var(--lx-accent); }
.tui-btn[data-active='true'] { color: var(--lx-accent); border-color: var(--lx-accent); }

.tui-gutter {
  /* 左侧 1px 竖线把正文收成「终端缓冲区」，比再加一层卡片边框更省视觉预算 */
  border-left: 1px solid var(--lx-border-subtle);
  margin-left: 10px;
  padding-left: 12px;
}

.tui-code {
  font-size: 12px;
  line-height: 1.7;
}

.tui-foot { border-top: 1px solid; font-size: 10px; letter-spacing: 0.04em; }
.tui-caret { color: var(--lx-accent); animation: tui-blink 1.1s steps(2, start) infinite; }

.tui-scan {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--lx-info), transparent);
  animation: tui-sweep 2.4s linear infinite;
  opacity: 0.7;
}

@keyframes tui-blink { to { opacity: 0; } }
@keyframes tui-sweep {
  from { transform: translateX(-40%); }
  to { transform: translateX(140%); }
}
</style>
