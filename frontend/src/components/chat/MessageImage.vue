<script setup lang="ts">
import {ref, watch} from 'vue';
import {t} from '../../i18n';

const props = defineProps<{src: string; alt?: string; title?: string; isDark: boolean; linked?: boolean}>();
const loading = ref(true);
const failed = ref(false);
const attempt = ref(0);
const preview = ref<HTMLDialogElement | null>(null);
const previewOpen = ref(false);

watch(() => props.src, () => {
  loading.value = true;
  failed.value = false;
  preview.value?.close();
});
const retry = () => {
  loading.value = true;
  failed.value = false;
  attempt.value++;
};
const openPreview = () => {
  // 带链接的图片保留原链接行为，避免在链接内嵌套交互按钮。
  if (!props.linked && !loading.value && !failed.value) {
    previewOpen.value = true;
    preview.value?.showModal();
  }
};
</script>

<template>
  <span class="message-image" :class="{'message-image--dark': isDark}" data-testid="message-image">
    <component :is="linked ? 'span' : 'button'" :type="linked ? undefined : 'button'"
      class="message-image-surface" :class="{'message-image-surface--loading': loading, 'message-image-surface--failed': failed}"
      :disabled="linked ? undefined : loading || failed"
      :aria-label="linked ? undefined : t('chat.message.previewImage', {path: alt || t('chat.message.imageLabel')})"
      :title="title" @click="openPreview">
      <img v-if="!failed" :key="attempt" :src="src" :alt="alt || t('chat.message.imageLabel')"
        loading="lazy" decoding="async" @load="loading = false" @error="loading = false; failed = true" />
      <span v-if="loading" class="message-image-placeholder" role="status">{{ t('chat.message.imageLoading') }}</span>
      <span v-else-if="failed" class="message-image-placeholder" role="status">{{ t('chat.message.imageUnavailable') }}</span>
    </component>
    <span v-if="alt || failed" class="message-image-caption">
      <span v-if="alt">{{ alt }}</span>
      <button v-if="failed && !linked" type="button" class="message-image-retry" @click="retry">{{ t('chat.message.imageRetry') }}</button>
    </span>
    <Teleport v-if="!linked" to="body">
      <dialog ref="preview" class="message-image-preview" :class="{'message-image--dark': isDark}"
        :aria-label="t('chat.message.previewImage', {path: alt || t('chat.message.imageLabel')})"
        @close="previewOpen = false" @click.self="preview?.close()">
        <div class="message-image-preview-toolbar">
          <span>{{ alt || t('chat.message.imageLabel') }}</span>
          <button type="button" autofocus :aria-label="t('common.close')" @click="preview?.close()">×</button>
        </div>
        <img v-if="previewOpen" :src="src" :alt="alt || t('chat.message.imageLabel')" />
      </dialog>
    </Teleport>
  </span>
</template>

<style scoped>
.message-image { display: inline-flex; flex-direction: column; vertical-align: top; width: min(100%, 28rem); max-width: 100%; margin: .5rem 0; color: var(--lx-text-muted); }
.message-image-surface { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; overflow: hidden; padding: 0; border: 1px solid rgb(0 0 0 / 9%); border-radius: 1rem; background: rgb(0 0 0 / 3%); cursor: zoom-in; }
.message-image-surface img { display: block; width: 100%; max-height: 32rem; object-fit: contain; margin: 0; border-radius: inherit; }
.message-image-surface--loading, .message-image-surface--failed { min-height: 12rem; cursor: default; }
.message-image-surface--loading img { opacity: 0; }
.message-image-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: .8125rem; }
.message-image-caption { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; padding: .5rem .125rem 0; font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
.message-image-retry { flex-shrink: 0; text-decoration: underline; text-underline-offset: .2em; cursor: pointer; }
.message-image-surface:focus-visible, .message-image-retry:focus-visible, .message-image-preview-toolbar button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.message-image--dark .message-image-surface { border-color: rgb(255 255 255 / 12%); background: rgb(255 255 255 / 4%); }
.message-image-preview { margin: auto; padding: 1rem; width: fit-content; max-width: 94vw; max-height: 94vh; border: 1px solid rgb(0 0 0 / 10%); border-radius: 1rem; background: #fff; color: #3f3f46; }
.message-image-preview.message-image--dark { border-color: rgb(255 255 255 / 12%); background: #18181b; color: #e4e4e7; }
.message-image-preview::backdrop { background: rgb(0 0 0 / 70%); }
.message-image-preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; font-size: .8125rem; }
.message-image-preview-toolbar span { min-width: 0; overflow-wrap: anywhere; }
.message-image-preview-toolbar button { flex-shrink: 0; width: 2rem; height: 2rem; border-radius: .5rem; font-size: 1.5rem; cursor: pointer; }
.message-image-preview-toolbar button:hover { background: rgb(127 127 127 / 12%); }
.message-image-preview > img { display: block; max-width: 100%; max-height: 78vh; margin: auto; object-fit: contain; }
</style>
