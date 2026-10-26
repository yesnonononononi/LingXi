<script setup lang="ts">
import { ref, watch } from 'vue';
import { renderMermaid } from '../../utils/mermaid';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { t } from '../../i18n';

const props = defineProps<{ source: string; complete: boolean; isDark: boolean }>();
const svg = ref('');
const failed = ref(false);
const { copy, isCopied } = useCopyFeedback();

watch(() => [props.source, props.complete, props.isDark] as const, async ([source, complete, dark], _previous, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  svg.value = '';
  failed.value = false;
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
  </section>
</template>
