<script setup lang="ts">
import {ref, watch} from 'vue';
import {renderMermaid} from '../../utils/mermaid';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {t} from '../../i18n';
import LxModal from '../common/LxModal.vue';

const props = defineProps<{ source: string; complete: boolean; isDark: boolean }>();
const svg = ref('');
const failed = ref(false);
const zoomOpen = ref(false);
const { copy, isCopied } = useCopyFeedback();

watch(() => [props.source, props.complete, props.isDark] as const, async ([source, complete, dark], _previous, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  svg.value = '';
  failed.value = false;
  zoomOpen.value = false;
  if (!complete) return;
  try {
    const result = await renderMermaid(source, dark);
    // 内容变化、主题切换和卸载后，旧请求都不再拥有写入权。
    if (current) svg.value = result;
  } catch {
    if (current) failed.value = true;
  }
}, { immediate: true });
</script>

<template>
  <section class="content-block mermaid-block" :class="{ 'mermaid-block--dark': isDark }">
    <div class="block-toolbar block-toolbar--diagram">
      <button
        v-if="svg"
        type="button"
        class="diagram-zoom-btn"
        :title="t('markdown.zoomDiagram')"
        :aria-label="t('markdown.zoomDiagram')"
        @click.stop="zoomOpen = true"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35M11 8v6M8 11h6" />
        </svg>
      </button>
      <button type="button" class="copy-code-btn" :title="t('markdown.copyCode')" @click.stop="copy(source)">
        {{ isCopied ? t('common.copied') : t('markdown.copy') }}
      </button>
    </div>
    <div v-if="svg" class="mermaid-diagram" role="img" :aria-label="t('markdown.diagram')" v-html="svg"></div>
    <template v-else>
      <p v-if="failed" class="mermaid-status" role="status">{{ t('markdown.diagramFailed') }}</p>
      <p v-else-if="complete" class="mermaid-status" role="status">{{ t('markdown.diagramLoading') }}</p>
      <pre><code>{{ source }}</code></pre>
    </template>

    <LxModal
      :open="zoomOpen && Boolean(svg)"
      :aria-label="t('markdown.diagram')"
      transition-name="lx-modal"
      overlay-class="z-50 bg-black/60 backdrop-blur-sm"
      :panel-class="isDark
        ? 'w-[90vw] max-w-[90vw] max-h-[90vh] flex flex-col rounded-xl border border-zinc-700/70 bg-zinc-900 text-zinc-200 p-4 shadow-2xl'
        : 'w-[90vw] max-w-[90vw] max-h-[90vh] flex flex-col rounded-xl border border-zinc-200 bg-white text-gray-800 p-4 shadow-2xl'"
      @close="zoomOpen = false"
    >
      <div class="flex items-center justify-between gap-4 mb-3 shrink-0">
        <span class="text-sm font-medium opacity-80">{{ t('markdown.diagram') }}</span>
        <button
          type="button"
          class="mermaid-lightbox-close flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none cursor-pointer transition-colors"
          :class="isDark ? 'hover:bg-white/10 text-zinc-300' : 'hover:bg-black/5 text-gray-600'"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click.stop="zoomOpen = false"
        >×</button>
      </div>
      <div class="mermaid-lightbox-body overflow-auto flex-1" v-html="svg"></div>
    </LxModal>
  </section>
</template>

<style scoped>
.mermaid-lightbox-body :deep(svg) {
  display: block;
  width: 100%;
  max-width: 100% !important;
  height: auto;
  max-height: 78vh;
  margin: 0 auto;
}
</style>
