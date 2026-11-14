<script setup lang="ts">
import {onMounted, ref, watch} from 'vue';
import {getApiBaseUrl} from '../../utils/apiConfig';
import {createLocalId} from '../../utils/ids';

export interface VariantSlot {
  path: string;
  label: string;
  html: string;
  loading: boolean;
  error: string;
}

const props = defineProps<{
  visible: boolean;
  variantPaths: string[];
  sessionId?: string | number | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'pick', payload: { html: string; label: string }): void;
  (e: 'generate'): void;
}>();

const slots = ref<VariantSlot[]>([]);

const loadVariants = async (): Promise<void> => {
  const paths = props.variantPaths;
  slots.value = paths.map((p, idx) => ({
    path: p,
    label: `方案 ${idx + 1}`,
    html: '',
    loading: true,
    error: '',
  }));

  const api = window.electronAPI;
  const sid = props.sessionId != null ? String(props.sessionId) : '';
  if (!api?.previewFile || !sid) {
    slots.value.forEach(s => {
      s.loading = false;
      s.error = '需要桌面端与活动会话才能读取方案文件';
    });
    return;
  }

  await Promise.all(
    slots.value.map(async slot => {
      try {
        const res = await api.previewFile!({
          sessionId: sid,
          path: slot.path,
          baseUrl: getApiBaseUrl() || window.location.origin,
          watchKey: createLocalId('variant'),
        });
        if (!res.ok) {
          slot.error = res.error;
        } else {
          if (res.data.watchId) void api.unwatchFile?.(res.data.watchId);
          slot.html = res.data.content;
        }
      } catch (err) {
        slot.error = err instanceof Error ? err.message : '读取失败';
      } finally {
        slot.loading = false;
      }
    })
  );
};

watch(() => props.visible, val => {
  if (val) void loadVariants();
});

onMounted(() => {
  if (props.visible) void loadVariants();
});
</script>

<template>
  <div v-if="visible" class="variants-modal-backdrop" @click.self="emit('close')">
    <div class="variants-modal" role="dialog" aria-label="多方案并排对比">
      <header class="variants-header">
        <div>
          <h3 class="variants-title">多方案并排对比</h3>
          <p class="variants-subtitle">从 3 个并行方案中挑选一个应用到主画布</p>
        </div>
        <div class="variants-header-actions">
          <button type="button" class="v-btn" @click="loadVariants">刷新方案</button>
          <button type="button" class="v-btn is-primary" @click="emit('generate')">让 AI 生成 3 个方案</button>
          <button type="button" class="v-close" title="关闭" @click="emit('close')">✕</button>
        </div>
      </header>

      <div class="variants-grid">
        <div v-for="slot in slots" :key="slot.path" class="variant-card">
          <div class="variant-card-head">
            <span class="variant-label">{{ slot.label }}</span>
            <span class="variant-path" :title="slot.path">{{ slot.path.split('/').pop() }}</span>
          </div>

          <div class="variant-preview-box">
            <div v-if="slot.loading" class="variant-state">读取中…</div>
            <div v-else-if="slot.error" class="variant-state is-muted">
              尚未生成或无法读取（{{ slot.error }}）
            </div>
            <iframe
              v-else
              class="variant-iframe"
              :srcdoc="slot.html"
              sandbox="allow-scripts"
              :title="slot.label"
            />
          </div>

          <div class="variant-card-foot">
            <button
              type="button"
              class="v-btn is-primary w-full"
              :disabled="!slot.html"
              @click="emit('pick', { html: slot.html, label: slot.label })"
            >
              选定并应用到主画布
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.variants-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.variants-modal {
  width: min(1240px, 95vw);
  height: min(760px, 88vh);
  background: var(--file-bg, #ffffff);
  color: var(--file-text, #18181b);
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.25);
}

.variants-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
}

.variants-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}

.variants-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--file-muted, #71717a);
}

.variants-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.v-btn {
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  cursor: pointer;
}

.v-btn.is-primary {
  background: var(--file-accent, #2563eb);
  border-color: var(--file-accent, #2563eb);
  color: #ffffff;
}

.v-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.v-close {
  border: none;
  background: transparent;
  color: var(--file-muted, #71717a);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
}

.variants-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 14px;
  overflow: hidden;
}

.variant-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 10px;
  background: var(--file-tab, #fafafa);
  overflow: hidden;
}

.variant-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  font-size: 12px;
}

.variant-label {
  font-weight: 600;
}

.variant-path {
  font-size: 11px;
  color: var(--file-muted, #71717a);
}

.variant-preview-box {
  flex: 1;
  min-height: 0;
  position: relative;
  background: #ffffff;
  overflow: hidden;
}

.variant-state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: #71717a;
}

.variant-iframe {
  width: 200%;
  height: 200%;
  border: none;
  transform: scale(0.5);
  transform-origin: top left;
  pointer-events: none;
}

.variant-card-foot {
  padding: 10px;
  border-top: 1px solid var(--file-line, #e4e4e7);
}
</style>
