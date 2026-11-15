<script setup lang="ts">
import {ref} from 'vue';
import type {FilePreviewTab} from '../../types/filePreview';
import type {PlanPreviewTab} from '../../types/previewPanel';
import {useI18n} from '../../i18n';

defineProps<{
  fileTabs: FilePreviewTab[];
  planTabs: PlanPreviewTab[];
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'openUrl', url: string): void;
  (e: 'openPage'): void;
  (e: 'openDesign'): void;
  (e: 'activateFile', id: string): void;
  (e: 'activatePlan', id: string): void;
}>();

const { t } = useI18n();
const urlDraft = ref('');

const submitUrl = () => {
  const value = urlDraft.value.trim();
  if (!value) {
    emit('openPage');
    return;
  }
  const normalized = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  emit('openUrl', normalized);
};
</script>

<template>
  <div class="new-tab-view" :class="{ 'is-dark': isDark }">
    <div class="new-tab-content">
      <section class="new-tab-section">
        <h3 class="section-label">{{ t('filePreview.toolsTitle') }}</h3>
        <div class="tools-grid">
          <div class="tool-card tool-card-page">
            <button
              type="button"
              class="tool-card-page-head"
              data-testid="new-tab-open-page"
              @click="emit('openPage')"
            >
              <span class="tool-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" />
                </svg>
              </span>
              <span class="tool-meta">
                <span class="tool-title">{{ t('filePreview.openPageTool') }}</span>
                <span class="tool-desc">{{ t('filePreview.openPageDesc') }}</span>
              </span>
            </button>

            <form class="new-tab-address-field" @submit.prevent="submitUrl">
              <input
                v-model="urlDraft"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :placeholder="t('filePreview.urlPlaceholder')"
                class="new-tab-address-input"
              />
              <button
                type="submit"
                class="new-tab-address-go"
                :title="t('projectPagePreview.openAddress')"
                :aria-label="t('projectPagePreview.openAddress')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </button>
            </form>
          </div>

          <button type="button" class="tool-card" data-testid="new-tab-open-design" @click="emit('openDesign')">
            <span class="tool-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.39m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
              </svg>
            </span>
            <span class="tool-meta">
              <span class="tool-title">{{ t('filePreview.openDesignTool') }}</span>
              <span class="tool-desc">{{ t('filePreview.openDesignDesc') }}</span>
            </span>
          </button>
        </div>
      </section>

      <section v-if="planTabs.length" class="new-tab-section">
        <h3 class="section-label">{{ t('filePreview.openPlanTool') }}</h3>
        <div class="tools-grid">
          <button
            v-for="plan in planTabs"
            :key="plan.id"
            type="button"
            class="tool-card"
            @click="emit('activatePlan', plan.id)"
          >
            <span class="tool-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z" />
              </svg>
            </span>
            <span class="tool-meta">
              <span class="tool-title">{{ plan.title }}</span>
              <span class="tool-desc">{{ t('filePreview.openPlanDesc') }}</span>
            </span>
          </button>
        </div>
      </section>

      <section class="new-tab-section">
        <h3 class="section-label">{{ t('filePreview.recentFiles') }}</h3>
        <div v-if="fileTabs.length" class="tools-grid">
          <button
            v-for="file in fileTabs"
            :key="file.id"
            type="button"
            class="tool-card"
            @click="emit('activateFile', file.id)"
          >
            <span class="tool-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />
              </svg>
            </span>
            <span class="tool-meta">
              <span class="tool-title">{{ file.name }}</span>
              <span class="tool-desc">{{ file.request.path }}</span>
            </span>
          </button>
        </div>
        <p v-else class="empty-hint">{{ t('filePreview.noRecentFiles') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.new-tab-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  background: var(--file-bg, #fff);
  color: inherit;
}
.new-tab-address-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px 5px 12px;
  border-radius: 9999px;
  background: var(--file-tab, #f4f4f5);
  border: 1px solid var(--file-line, #e4e4e7);
  transition: border-color 150ms ease;
}
.new-tab-address-field:focus-within {
  border-color: var(--file-focus, #a1a1aa);
}
.new-tab-address-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--lx-font-size-md, 13px);
  outline: none;
}
.new-tab-address-input::placeholder {
  color: var(--file-muted, #71717a);
}
.new-tab-address-go {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  border: 0;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  flex-shrink: 0;
}
.new-tab-address-go:hover {
  background: var(--file-line, #e4e4e7);
  color: inherit;
}
.new-tab-address-go svg {
  width: 14px;
  height: 14px;
}
.new-tab-content {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.new-tab-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section-label {
  margin: 0;
  font-size: var(--lx-font-size-sm, 12px);
  font-weight: 600;
  color: var(--file-muted, #71717a);
}
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}
.tool-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease;
  min-width: 0;
}
.tool-card:hover {
  background: var(--file-tab, #f4f4f5);
}
.tool-card-page {
  grid-column: 1 / -1;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  cursor: default;
}
.tool-card-page:hover {
  background: transparent;
}
.tool-card-page-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.tool-card-page-head:hover .tool-title {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.tool-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--file-tab, #f4f4f5);
  color: var(--file-muted, #71717a);
  flex-shrink: 0;
}
.tool-icon svg {
  width: 15px;
  height: 15px;
}
.tool-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.tool-title {
  font-size: var(--lx-font-size-md, 13px);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-desc {
  font-size: var(--lx-font-size-xs, 11px);
  color: var(--file-muted, #71717a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-hint {
  margin: 0;
  font-size: var(--lx-font-size-sm, 12.5px);
  color: var(--file-muted, #71717a);
}
</style>
