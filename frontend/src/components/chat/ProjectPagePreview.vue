<script setup lang="ts">
/**
 * 项目页面预览正文（阶段一）。
 *
 * <p>只负责渲染：地址输入、[打开]、[重新加载]、状态行、iframe。
 * 全部状态来自 {@link PROJECT_PAGE_PREVIEW_KEY} 注入的 composable（ChatView 持有的唯一真源），
 * 组件自身不持有地址或加载状态 —— 否则关掉面板再打开就会拿到两份不同的真相。</p>
 *
 * <p>iframe 的安全口径：</p>
 * <ul>
 *   <li>sandbox 只放行 allow-scripts / allow-same-origin / allow-forms / allow-modals：
 *       项目页面需要跑自己的脚本、读自己的同源资源、提交表单和调用 alert 类原生弹窗；
 *       但**不**给 allow-top-navigation（不能把 LingXi 主页面导航走）、
 *       不给 allow-popups（OAuth 弹窗阶段一不承诺）、不给 allow-downloads。</li>
 *   <li>referrerpolicy=no-referrer：不把 LingXi 的地址带给用户项目页面。</li>
 *   <li>不给页面任何 Node / Electron 能力：nodeIntegration 关闭由 BrowserWindow 决定，
 *       iframe 本身也没有 preload。</li>
 * </ul>
 */
import {computed, inject} from 'vue';
import {t} from '../../i18n';
import {useProjectPagePreview} from '../../composables/useProjectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../types/projectPagePreview';

const injected = inject(PROJECT_PAGE_PREVIEW_KEY, null);
/**
 * 状态来源：正常场景由 ChatView provide 同一份；独立挂载（如冒烟用例只挂面板）时自建一份兜底实例，
 * 保证组件永远有可用状态，而不是抛错把整块面板拖死。
 */
const preview = injected ?? useProjectPagePreview();


const {
  addressInput,
  committedUrl,
  generation,
  loadState,
  addressError,
  statusText,
  diagnoseText,
  openAddress,
  updateAddress,
  reload,
  handleFrameLoad,
} = preview;

/** sandbox 白名单（顺序即语义，便于阅读）。 */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';

const frameTitle = computed(() => t('projectPagePreview.frameTitle'));

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
      <button type="submit" class="primary" :aria-label="t('projectPagePreview.openAddress')">
        {{ t('projectPagePreview.openAddress') }}
      </button>
      <button
        type="button"
        :disabled="!committedUrl"
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

    <div class="frame-area">
      <!--
        key 用 generation：每次加载尝试/重新加载都换一个新实例（重新加载必须恢复页面初始化行为）；
        隐藏面板或切换文件模式不会改变 generation，实例因此保留输入与登录状态。
      -->
      <iframe
        v-if="committedUrl"
        :key="generation"
        class="page-frame"
        :src="committedUrl"
        :title="frameTitle"
        :sandbox="FRAME_SANDBOX"
        referrerpolicy="no-referrer"
        @load="handleFrameLoad"
      ></iframe>
      <div v-else class="frame-placeholder">{{ t('projectPagePreview.emptyHint') }}</div>
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
.page-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.frame-placeholder { height: 100%; display: grid; place-items: center; padding: 0 20px; font-size: var(--lx-font-size-md); color: var(--file-muted, #71717a); text-align: center; }
</style>
