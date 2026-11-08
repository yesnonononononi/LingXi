<script setup lang="ts">
/** 原生视图不参与 DOM 排版，面板只同步占位区域与可见性。 */
import {computed, inject, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {t} from '../../i18n';
import {useProjectPagePreview} from '../../composables/useProjectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../types/projectPagePreview';

const props = withDefaults(defineProps<{active?: boolean}>(), {active: true});
const preview = inject(PROJECT_PAGE_PREVIEW_KEY, null) ?? useProjectPagePreview();
const nativeAvailable = typeof window.electronAPI?.projectPage?.navigate === 'function';
const frameArea = ref<HTMLElement | null>(null);
let animationFrame = 0;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let lastLayout = '';

const syncViewport = (): void => {
  animationFrame = 0;
  const element = frameArea.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  // 原生视图位于 DOM 上方；弹窗显示期间隐藏，避免遮挡确认按钮。
  const modalOpen = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]'))
    .some(modal => modal.getClientRects().length > 0 && getComputedStyle(modal).visibility !== 'hidden');
  const layout = {
    visible: props.active && rect.width > 2 && rect.height > 2 && !modalOpen && getComputedStyle(element).visibility !== 'hidden',
    bounds: {x: rect.x + 1, y: rect.y + 1, width: Math.max(0, rect.width - 2), height: Math.max(0, rect.height - 2)},
  };
  const signature = JSON.stringify([preview.generation.value, layout]);
  if (signature === lastLayout) return;
  lastLayout = signature;
  preview.updateLayout(layout);
};

const scheduleViewport = (): void => {
  if (!animationFrame) animationFrame = requestAnimationFrame(syncViewport);
};

watch(() => [props.active, preview.generation.value, preview.committedUrl.value], scheduleViewport, {flush: 'post'});
onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleViewport);
  if (frameArea.value) resizeObserver.observe(frameArea.value);
  mutationObserver = new MutationObserver(scheduleViewport);
  mutationObserver.observe(document.body, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-modal']});
  window.addEventListener('resize', scheduleViewport);
  window.addEventListener('scroll', scheduleViewport, true);
  document.addEventListener('transitionend', scheduleViewport, true);
  scheduleViewport();
});
onBeforeUnmount(() => {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  window.removeEventListener('resize', scheduleViewport);
  window.removeEventListener('scroll', scheduleViewport, true);
  document.removeEventListener('transitionend', scheduleViewport, true);
  preview.updateLayout({visible: false, bounds: {x: 0, y: 0, width: 0, height: 0}});
});

const {
  addressInput,
  committedUrl,
  loadState,
  addressError,
  statusText,
  diagnoseText,
  openAddress,
  updateAddress,
  reload,
} = preview;

/** 状态行的样式档：超时/失败要显眼，加载中弱化。 */
const stateClass = computed(() => `state-${loadState.value}`);

const onAddressInput = (event: Event): void => {
  const target = event.target as HTMLInputElement | null;
  updateAddress(target ? target.value : '');
};

const submit = (): void => {
  openAddress(addressInput.value);
};
</script>

<template>
  <div class="project-page-preview">
    <form class="address-bar" @submit.prevent="submit">
      <input
        class="address-input"
        type="text"
        name="project-page-address"
        autocomplete="off"
        spellcheck="false"
        :value="addressInput"
        :aria-label="t('projectPagePreview.addressAria')"
        :placeholder="t('projectPagePreview.addressPlaceholder')"
        :aria-invalid="addressError ? 'true' : 'false'"
        @input="onAddressInput"
      />
      <button type="submit" class="primary" :disabled="!nativeAvailable" :aria-label="t('projectPagePreview.openAddress')">
        {{ t('projectPagePreview.openAddress') }}
      </button>
      <button
        type="button"
        :disabled="!nativeAvailable || !committedUrl"
        :aria-label="t('projectPagePreview.reload')"
        @click="reload"
      >
        {{ t('projectPagePreview.reload') }}
      </button>
    </form>

    <p v-if="addressError" class="address-error" role="alert">{{ addressError }}</p>

    <div class="status-row">
      <span class="status-text" :class="stateClass" role="status">{{ statusText }}</span>
      <span class="browse-mode">{{ t('projectPagePreview.browseMode') }}</span>
    </div>

    <p v-if="diagnoseText" class="diagnose-text" role="note">{{ diagnoseText }}</p>

    <div ref="frameArea" class="frame-area" :aria-label="t('projectPagePreview.frameTitle')">
      <div v-if="!nativeAvailable" class="frame-placeholder">{{ t('projectPagePreview.desktopRequired') }}</div>
      <div v-else-if="!committedUrl" class="frame-placeholder">{{ t('projectPagePreview.emptyHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.project-page-preview { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; padding: 12px 16px 14px; }
.address-bar { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.address-input { flex: 1; min-width: 0; padding: 6px 10px; font-size: var(--lx-font-size-md); font-family: inherit; color: inherit; background: var(--file-tab, #f4f4f5); border: 1px solid var(--file-line, #e4e4e7); border-radius: 8px; }
.address-input:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
.address-bar button { flex-shrink: 0; padding: 6px 10px; font-size: var(--lx-font-size-md); color: inherit; cursor: pointer; background: transparent; border: 1px solid var(--file-line, #e4e4e7); border-radius: 8px; }
.address-bar button.primary { color: #fff; background: #6366f1; border-color: #6366f1; }
.address-bar button:hover:not(:disabled) { filter: brightness(.96); }
.address-bar button:disabled { opacity: .45; cursor: default; }
.address-bar button:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
.address-error { margin: 0; font-size: var(--lx-font-size-md); color: #dc2626; }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: var(--lx-font-size-sm); color: var(--file-muted, #71717a); }
.status-text.state-timeout { color: #b45309; }
.status-text.state-failed { color: #dc2626; }
.browse-mode { opacity: .85; }
.diagnose-text { margin: 0; font-size: var(--lx-font-size-sm); color: #b45309; }
.frame-area { flex: 1; min-height: 0; overflow: hidden; border: 1px solid var(--file-line, #e4e4e7); border-radius: 10px; background: #fff; }
.frame-placeholder { height: 100%; display: grid; place-items: center; padding: 0 20px; font-size: var(--lx-font-size-md); color: var(--file-muted, #71717a); text-align: center; }
</style>
