<script setup lang="ts">
import {computed, inject, ref} from 'vue';
import type {ImageProcessItem} from '../../utils/readImageTools';
import type {ThoughtStep} from '../../types/chat';
import type {ThinkingScrollApi} from '../../components/chat/process/processRenderers';
import {formatThoughtTitle} from '../../utils/toolRowUi';
import {PROCESS_SEGMENT_SCROLL_KEY} from '../../types/processScroll';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.vue';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  isRunningTurn: boolean;
  isMessageComplete?: boolean;
  messageIsSuspended: boolean;
  scroll: ThinkingScrollApi;
}>();

const step = computed<ThoughtStep | undefined>(() => props.item.step);
const userExpanded = ref<boolean | undefined>(undefined);
const defaultExpanded = computed(() => !!step.value && step.value.status === 'running' && props.isMessageComplete === false);
const isExpanded = computed(() => userExpanded.value ?? defaultExpanded.value);
const isAnimating = computed(() => !!step.value && step.value.status === 'running' && !props.messageIsSuspended && props.isRunningTurn);
const lineCount = computed(() => (step.value?.content ? step.value.content.split('\n').length : 0));

const segmentScroll = inject(PROCESS_SEGMENT_SCROLL_KEY, null);
const toggle = (): void => {
  segmentScroll?.pauseAutoFollow();
  userExpanded.value = !isExpanded.value;
};
</script>

<!--
  思维星图卡（内置 Slot 极限）→ 终端里的 `think` 缓冲。
  只保留三种信息：这行在干什么、跑了多久（行数）、现在是否还在跑。
-->
<template>
  <div
    v-if="step"
    data-slot="process-thought"
    class="tui-think w-full overflow-hidden transition-colors duration-200"
    :style="{
      backgroundColor: 'color-mix(in srgb, var(--lx-surface-sunken) 92%, var(--lx-info) 8%)',
      borderColor: isAnimating ? 'color-mix(in srgb, var(--lx-info) 50%, var(--lx-border-default))' : 'var(--lx-border-subtle)',
    }"
  >
    <button
      type="button"
      class="tui-row flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left cursor-pointer"
      @click="toggle"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="tui-mark shrink-0" :style="{ color: isAnimating ? 'var(--lx-info)' : 'var(--lx-text-faint)' }">▌</span>
        <span class="tui-label shrink-0" :style="{ color: 'var(--lx-info)' }">think</span>
        <span class="tui-title truncate" :style="{ color: 'var(--lx-text-secondary)' }">
          {{ formatThoughtTitle(step.title) }}
        </span>
        <span v-if="isAnimating" class="tui-caret shrink-0" aria-hidden="true">▊</span>
      </div>

      <div class="tui-meta flex shrink-0 items-center gap-2">
        <span v-if="lineCount" class="tabular-nums">{{ lineCount }}L</span>
        <span :style="{ color: isAnimating ? 'var(--lx-info)' : 'var(--lx-text-faint)' }">
          {{ isAnimating ? 'running' : 'ok' }}
        </span>
        <span class="tui-chev" :class="isExpanded ? 'is-open' : ''" aria-hidden="true">›</span>
      </div>
    </button>

    <div v-if="isExpanded && step.content" class="relative" :style="{ borderColor: 'var(--lx-border-subtle)' }">
      <div
        :ref="(el) => step && props.scroll.setBoxRef(step.id, el)"
        class="tui-buffer max-h-72 overflow-y-auto px-3 py-2 select-text"
        @scroll="step && props.scroll.handleScroll(step.id, $event)"
      >
        <MarkdownRenderer
          :content="step.content"
          :is-dark="props.isDark"
          :thinking-text="true"
          :streaming="isAnimating"
          :reveal-initial="isAnimating"
          @content-rendered="props.scroll.isFollowing(step.id) && props.scroll.scrollToBottom(step.id)"
        />
      </div>

      <button
        v-if="step.status === 'running' && !props.scroll.isFollowing(step.id)"
        type="button"
        class="tui-jump"
        :style="{ backgroundColor: 'var(--lx-surface-elevated)', borderColor: 'var(--lx-info)', color: 'var(--lx-info)' }"
        @click="props.scroll.scrollToBottom(step.id)"
      >↓ bottom</button>
    </div>
  </div>
</template>

<style scoped>
.tui-think {
  border: 1px solid;
  border-radius: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.tui-row { font-size: 11px; }
.tui-mark { font-size: 11px; line-height: 1; }
.tui-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
.tui-title { font-size: 11px; }
.tui-meta { font-size: 10px; color: var(--lx-text-faint); letter-spacing: 0.04em; }

.tui-chev {
  display: inline-block;
  transition: transform 0.18s ease;
  color: var(--lx-text-faint);
}
.tui-chev.is-open { transform: rotate(90deg); }

.tui-buffer {
  border-top: 1px solid var(--lx-border-subtle);
  border-left: 2px solid color-mix(in srgb, var(--lx-info) 60%, transparent);
  margin-left: 10px;
  font-size: 12px;
  line-height: 1.7;
}

.tui-jump {
  position: absolute;
  right: 10px;
  bottom: 8px;
  padding: 1px 7px;
  font-size: 10px;
  border: 1px solid;
  border-radius: 3px;
  cursor: pointer;
}

.tui-caret { color: var(--lx-info); animation: tui-blink 1.1s steps(2, start) infinite; }
@keyframes tui-blink { to { opacity: 0; } }
</style>
