<script setup lang="ts">
/** 原生视图不参与 DOM 排版，面板只同步占位区域与可见性。 */
import {computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {t} from '../../i18n';
import {useProjectPagePreview} from '../../composables/useProjectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../types/projectPagePreview';
import type {ProjectPageTab} from '../../types/projectPagePreview';

const props = withDefaults(defineProps<{active?: boolean}>(), {active: true});
const preview = inject(PROJECT_PAGE_PREVIEW_KEY, null) ?? useProjectPagePreview();
const nativeAvailable = typeof window.electronAPI?.projectPage?.command === 'function';
const frameArea = ref<HTMLElement | null>(null);
const tabsBar = ref<HTMLElement | null>(null);
const addressField = ref<HTMLInputElement | null>(null);
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

/**
 * 标签居中只更新容器 scrollLeft，不调用 scrollIntoView 避免祖先窗口横向漂移。
 *
 * <p>容器必须取标签栏本身：`#page-tab-*` 是标签内的按钮，`parentElement` 只是
 * `.page-tab`（不可滚动），往它上面写 scrollLeft 等于什么都没做 —— 面板被拖窄后
 * 当前标签就停在可视区外。位置用两边 getBoundingClientRect 求差，不依赖 offsetParent。</p>
 */
const scrollActiveTabIntoView = (): void => {
  const activeId = preview.activeTabId.value;
  if (!activeId) return;
  const tabEl = document.getElementById(`page-tab-${activeId}`);
  const container = tabsBar.value;
  if (!tabEl || !container) return;
  // 关闭按钮与标签同属 .page-tab，取外层标签框保证按钮一起进入可视区。
  const tabBox = (tabEl.closest('.page-tab') as HTMLElement | null) ?? tabEl;
  const tabRect = tabBox.getBoundingClientRect();
  const barRect = container.getBoundingClientRect();
  if (tabRect.left < barRect.left) {
    container.scrollLeft -= barRect.left - tabRect.left;
  } else if (tabRect.right > barRect.right) {
    container.scrollLeft += tabRect.right - barRect.right;
  }
};

const scheduleViewport = (): void => {
  if (!animationFrame) animationFrame = requestAnimationFrame(syncViewport);
};

watch(() => [props.active, preview.open.value, preview.generation.value, preview.activeTabId.value, preview.committedUrl.value], () => {
  scheduleViewport();
  scrollActiveTabIntoView();
}, {flush: 'post'});
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    scheduleViewport();
    // 面板被拖窄时标签栏自身变窄，但没有任何状态变化会触发重排滚位：
    // 必须盯住标签栏自己的宽度，并在布局落定后的下一帧再算一次。
    requestAnimationFrame(scrollActiveTabIntoView);
  });
  if (frameArea.value) resizeObserver.observe(frameArea.value);
  if (tabsBar.value) resizeObserver.observe(tabsBar.value);
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
  tabs,
  activeTabId,
  activeTab,
  createTab,
  activateTab,
  closeTab,
  goBack,
  goForward,
  stop,
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

const resolveTabTitle = (tab: ProjectPageTab): string => {
  if (tab.title) return tab.title;
  if (tab.url) return new URL(tab.url).hostname;
  return t('projectPagePreview.newTab');
};
const moveTab = (direction: number): void => {
  if (!tabs.value.length) return;
  const index = tabs.value.findIndex(tab => tab.id === activeTabId.value);
  const target = tabs.value[(index + direction + tabs.value.length) % tabs.value.length];
  if (target) activateTab(target.id);
};
watch(activeTabId, async () => {
  const keyboardFocus = document.activeElement?.closest('.page-tabs');
  await nextTick();
  const button = document.getElementById(`page-tab-${activeTabId.value}`);
  scrollActiveTabIntoView();
  if (!committedUrl.value) addressField.value?.focus();
  else if (keyboardFocus) button?.focus();
});

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
    <div class="tab-bar">
      <div ref="tabsBar" class="page-tabs" role="tablist" :aria-label="t('projectPagePreview.tabsLabel')"
        @keydown.right.prevent="moveTab(1)" @keydown.left.prevent="moveTab(-1)">
        <div v-for="tab in tabs" :key="tab.id" class="page-tab" :class="{'is-active': tab.id === activeTabId}" role="presentation">
          <button :id="`page-tab-${tab.id}`" type="button" role="tab" class="tab-label" :aria-selected="tab.id === activeTabId"
            :tabindex="tab.id === activeTabId ? 0 : -1" aria-controls="project-page-viewport" :title="tab.url || resolveTabTitle(tab)"
            @click="activateTab(tab.id)" @auxclick.middle.prevent="closeTab(tab.id)">
            <span v-if="tab.isLoading" class="tab-spinner" aria-hidden="true"></span>
            <span v-else class="tab-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/></svg>
              <img v-if="tab.favicon" :key="tab.favicon" :src="tab.favicon" alt="" referrerpolicy="no-referrer" @error="($event.target as HTMLImageElement).hidden = true" />
            </span>
            <span class="tab-title">{{ resolveTabTitle(tab) }}</span>
          </button>
          <button type="button" class="close-page-tab" :aria-label="t('projectPagePreview.closeTab', {name: resolveTabTitle(tab)})" @click="closeTab(tab.id)">×</button>
        </div>
      </div>
      <button type="button" class="new-page-tab" :disabled="!nativeAvailable" :aria-label="t('projectPagePreview.newTab')" :title="t('projectPagePreview.newTab')" @click="createTab">＋</button>
    </div>
    <form class="address-bar" @submit.prevent="submit">
      <button type="button" class="navigation-button" :disabled="!activeTab?.canGoBack" :aria-label="t('projectPagePreview.back')" :title="t('projectPagePreview.back')" @click="goBack">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 5-7 7 7 7M5 12h15"/></svg>
      </button>
      <button type="button" class="navigation-button" :disabled="!activeTab?.canGoForward" :aria-label="t('projectPagePreview.forward')" :title="t('projectPagePreview.forward')" @click="goForward">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 5 7 7-7 7M19 12H4"/></svg>
      </button>
      <button v-if="activeTab?.isLoading" type="button" class="navigation-button" :aria-label="t('projectPagePreview.stop')" :title="t('projectPagePreview.stop')" @click="stop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M6 18 18 6"/></svg>
      </button>
      <button v-else type="button" class="navigation-button" :disabled="!nativeAvailable || !committedUrl" :aria-label="t('projectPagePreview.reload')" :title="t('projectPagePreview.reload')" @click="reload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7v5"/></svg>
      </button>
      <!-- 地址输入：右箭头内嵌在输入框末尾（不再是独立「打开」按钮，省一行宽度给窄面板） -->
      <div class="address-field">
        <input
          ref="addressField"
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
        <button type="submit" class="address-go" :disabled="!nativeAvailable || !activeTabId"
          :aria-label="t('projectPagePreview.openAddress')" :title="t('projectPagePreview.openAddress')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
        </button>
      </div>
    </form>

    <p v-if="addressError" class="address-error" role="alert">{{ addressError }}</p>

    <div class="status-row">
      <span class="status-text" :class="stateClass" role="status">{{ statusText }}</span>
      <span class="browse-mode">{{ t('projectPagePreview.browseMode') }}</span>
    </div>

    <p v-if="diagnoseText" class="diagnose-text" role="note">{{ diagnoseText }}</p>

    <div id="project-page-viewport" ref="frameArea" class="frame-area" role="tabpanel" :aria-labelledby="activeTabId ? `page-tab-${activeTabId}` : undefined" :aria-label="t('projectPagePreview.frameTitle')">
      <div v-if="!nativeAvailable" class="frame-placeholder">{{ t('projectPagePreview.desktopRequired') }}</div>
      <div v-else-if="!committedUrl" class="frame-placeholder">{{ t('projectPagePreview.emptyHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.project-page-preview { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; padding: 12px 16px 14px; }
.tab-bar { display: flex; align-items: center; gap: 4px; min-width: 0; flex-shrink: 0; }
.page-tabs { display: flex; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
.page-tab { display: flex; align-items: center; flex: 0 0 170px; min-width: 0; border: 1px solid transparent; border-radius: 9px; background: var(--file-tab, #f4f4f5); color: var(--file-muted, #71717a); }
.page-tab.is-active { color: inherit; border-color: var(--file-line, #e4e4e7); background: var(--file-bg, #fff); }
.tab-label { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; padding: 8px; background: none; border: 0; color: inherit; cursor: pointer; font: inherit; font-size: var(--lx-font-size-md); }
.tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-icon, .tab-spinner { position: relative; width: 15px; height: 15px; flex-shrink: 0; }
.tab-icon svg, .tab-icon img { width: 100%; height: 100%; }
.tab-icon img { position: absolute; inset: 0; background: var(--file-bg, #fff); object-fit: contain; }
.tab-icon img[hidden] { display: none; }
.tab-spinner { border: 1.5px solid var(--file-line, #e4e4e7); border-top-color: currentColor; border-radius: 50%; animation: tab-spin .8s linear infinite; }
@keyframes tab-spin { to { transform: rotate(360deg); } }
.close-page-tab, .new-page-tab { flex-shrink: 0; border: 0; background: none; color: inherit; cursor: pointer; border-radius: 6px; font-size: 20px; }
.close-page-tab { padding: 1px 6px; margin-right: 3px; }
.new-page-tab { padding: 3px 7px; }
.close-page-tab:hover, .new-page-tab:hover { background: var(--file-line, #e4e4e7); }
.tab-bar button:focus-visible { outline: 2px solid var(--file-focus, #a1a1aa); outline-offset: -2px; }
.new-page-tab:disabled { opacity: .45; cursor: default; }
.address-bar .navigation-button { display: grid; place-items: center; padding: 6px; border-color: transparent; }
.navigation-button svg { width: 17px; height: 17px; }
.address-bar { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
/* 输入框 + 内嵌右箭头：箭头绝对定位在输入框末尾，输入框右侧预留同宽内边距，文字不会压到箭头上 */
.address-field { position: relative; display: flex; flex: 1; min-width: 0; }
.address-input { flex: 1; min-width: 0; padding: 6px 32px 6px 10px; font-size: var(--lx-font-size-md); font-family: inherit; color: inherit; background: var(--file-tab, #f4f4f5); border: 1px solid var(--file-line, #e4e4e7); border-radius: 8px; }
.address-input:focus-visible { outline: 1px solid var(--file-focus, #a1a1aa); outline-offset: -1px; }
.address-go { position: absolute; top: 50%; right: 3px; transform: translateY(-50%); display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--file-muted, #71717a); cursor: pointer; transition: background-color .12s, color .12s; }
.address-go svg { width: 16px; height: 16px; }
.address-go:hover:not(:disabled) { background: var(--file-line, #e4e4e7); color: var(--file-ink, #18181b); }
.address-go:disabled { opacity: .4; cursor: default; }
.address-go:focus-visible { outline: 2px solid var(--file-focus, #a1a1aa); outline-offset: 1px; }
.address-bar > button { flex-shrink: 0; padding: 6px 10px; font-size: var(--lx-font-size-md); color: inherit; cursor: pointer; background: transparent; border: 1px solid var(--file-line, #e4e4e7); border-radius: 8px; }
.address-bar > button:hover:not(:disabled) { background: var(--file-tab, #f4f4f5); }
.address-bar > button:disabled { opacity: .45; cursor: default; }
.address-bar > button:focus-visible { outline: 2px solid var(--file-focus, #a1a1aa); outline-offset: 1px; }
.address-error { margin: 0; font-size: var(--lx-font-size-md); color: #dc2626; }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: var(--lx-font-size-sm); color: var(--file-muted, #71717a); }
.status-text.state-timeout { color: #b45309; }
.status-text.state-failed { color: #dc2626; }
.browse-mode { opacity: .85; }
.diagnose-text { margin: 0; font-size: var(--lx-font-size-sm); color: #b45309; }
.frame-area { flex: 1; min-height: 0; overflow: hidden; border: 1px solid var(--file-line, #e4e4e7); border-radius: 10px; background: #fff; }
.frame-placeholder { height: 100%; display: grid; place-items: center; padding: 0 20px; font-size: var(--lx-font-size-md); color: var(--file-muted, #71717a); text-align: center; }
</style>
