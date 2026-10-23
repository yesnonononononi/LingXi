<script setup lang="ts">
import { ref } from 'vue';
import type { ReadToolImage } from '../../utils/readImageTools';
import { resolveApiUrl } from '../../utils/apiConfig';
import { t } from '../../i18n';
import CollapseTransition from '../common/CollapseTransition.vue';

const props = defineProps<{ images: ReadToolImage[]; sessionId: string | number; isDark: boolean }>();
const expanded = ref(true);
const failedImages = ref<Record<string, boolean>>({});
const selected = ref<ReadToolImage | null>(null);
const preview = ref<HTMLDialogElement | null>(null);
const imageUrl = (image: ReadToolImage) => resolveApiUrl(`/a/images/${props.sessionId}/${image.imageId}.${image.ext}`);
const openPreview = (image: ReadToolImage) => {
  selected.value = image;
  preview.value?.showModal();
};
</script>

<template>
  <div data-testid="read-image-group" class="w-full min-w-0 text-[13px] text-lx-muted">
    <button type="button" data-testid="read-image-toggle" class="flex items-center gap-1.5 py-0.5 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-200" :aria-expanded="expanded" @click="expanded = !expanded">
      <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="7" y="3" width="14" height="14" rx="3" />
        <rect x="3" y="7" width="14" height="14" rx="3" :fill="isDark ? '#18181b' : 'white'" />
        <circle cx="7" cy="11" r="1" /><path stroke-linecap="round" stroke-linejoin="round" d="m4 18 4-4 3 3 2-2 3 3" />
      </svg>
      <span>{{ t('chat.message.viewedImages', { count: images.length }) }}</span>
      <svg class="h-3 w-3 transition-transform" :class="expanded ? '' : '-rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
    </button>
    <CollapseTransition>
      <div v-if="expanded" class="flex flex-wrap gap-2 pt-2 pb-0.5" data-testid="read-image-thumbnails">
        <button v-for="image in images" :key="image.key" type="button" class="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border p-1.5 transition-colors" :class="isDark ? 'border-white/15 bg-zinc-900 hover:bg-zinc-800' : 'border-zinc-200 bg-white hover:bg-zinc-50'" :title="image.path" :aria-label="t('chat.message.previewImage', { path: image.path })" :disabled="failedImages[image.key]" @click="openPreview(image)">
          <span v-if="failedImages[image.key]" class="text-[11px] leading-4">{{ t('chat.message.imageUnavailable') }}</span>
          <img v-else :src="imageUrl(image)" :alt="image.path" class="h-full w-full object-contain object-top" loading="lazy" @error="failedImages[image.key] = true" />
        </button>
      </div>
    </CollapseTransition>
    <Teleport to="body">
      <dialog ref="preview" class="read-image-preview rounded-2xl border p-4 shadow-xl" :class="isDark ? 'border-white/15 bg-zinc-900 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-700'" :aria-label="t('chat.message.previewImage', { path: selected?.path ?? '' })" @click="($event.target === preview) && preview?.close()">
        <div class="mb-3 flex items-center justify-between gap-4 text-sm">
          <span class="truncate">{{ selected?.path }}</span>
          <button type="button" class="shrink-0 cursor-pointer rounded p-1" :aria-label="t('common.close')" @click="preview?.close()">✕</button>
        </div>
        <img v-if="selected" :src="imageUrl(selected)" :alt="selected.path" class="mx-auto max-h-[80vh] max-w-full object-contain" />
      </dialog>
    </Teleport>
  </div>
</template>

<style scoped>
.read-image-preview { margin: auto; max-width: min(92vw, 1200px); max-height: 94vh; }
.read-image-preview::backdrop { background: rgb(0 0 0 / 65%); }
</style>
