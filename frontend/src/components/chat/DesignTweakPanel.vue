<script setup lang="ts">
import type {DesignTweakVar} from '../../utils/designCanvasHelpers';

defineProps<{
  tweakVars: DesignTweakVar[];
  tweakValues: Record<string, string>;
  injectProjectTokens: boolean;
  customTokens: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updateTweak', name: string, value: string): void;
  (e: 'update:injectProjectTokens', val: boolean): void;
  (e: 'update:customTokens', val: string): void;
  (e: 'askAiExposeTweaks'): void;
}>();
</script>

<template>
  <aside class="design-side-drawer" aria-label="调参与设计规范">
    <header class="drawer-header">
      <div class="drawer-title">
        <span>调参与设计系统</span>
      </div>
      <button type="button" class="drawer-close-btn" title="关闭" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-scroll">
      <section class="panel-section">
        <div class="section-head">
          <span class="section-title">实时调参 (--lx-tweak-*)</span>
        </div>

        <div v-if="tweakVars.length === 0" class="tweak-empty">
          <p>当前原型尚未声明 <code>--lx-tweak-*</code> CSS 变量。</p>
          <button type="button" class="drawer-mini-btn is-primary" @click="emit('askAiExposeTweaks')">
            让 AI 暴露可调参数
          </button>
        </div>

        <div v-else class="tweak-list">
          <div v-for="item in tweakVars" :key="item.name" class="tweak-row">
            <div class="tweak-label-row">
              <span class="tweak-label" :title="item.name">{{ item.label }}</span>
              <span class="tweak-val">{{ tweakValues[item.name] ?? item.value }}</span>
            </div>

            <div v-if="item.kind === 'color'" class="tweak-control">
              <input
                type="color"
                class="tweak-color"
                :value="tweakValues[item.name] ?? item.value"
                @input="emit('updateTweak', item.name, ($event.target as HTMLInputElement).value)"
              />
              <input
                type="text"
                class="tweak-text-input"
                :value="tweakValues[item.name] ?? item.value"
                @change="emit('updateTweak', item.name, ($event.target as HTMLInputElement).value)"
              />
            </div>

            <div v-else-if="item.kind === 'length'" class="tweak-control">
              <input
                type="range"
                class="tweak-range"
                :min="item.min ?? 0"
                :max="item.max ?? 100"
                :value="parseFloat(tweakValues[item.name] ?? item.value) || 0"
                @input="emit('updateTweak', item.name, `${($event.target as HTMLInputElement).value}${item.unit || 'px'}`)"
              />
            </div>

            <div v-else class="tweak-control">
              <input
                type="text"
                class="tweak-text-input"
                :value="tweakValues[item.name] ?? item.value"
                @change="emit('updateTweak', item.name, ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="panel-section">
        <div class="section-head">
          <span class="section-title">设计系统注入</span>
        </div>

        <label class="token-toggle">
          <input
            type="checkbox"
            :checked="injectProjectTokens"
            @change="emit('update:injectProjectTokens', ($event.target as HTMLInputElement).checked)"
          />
          <span>发给 AI 时自动套用项目令牌 (tokens.css)</span>
        </label>

        <label class="token-notes-label">
          <span>自定义品牌规范 / 色板（可选）</span>
          <textarea
            class="token-notes-input"
            rows="4"
            :value="customTokens"
            placeholder="例如：主色 #0F766E，圆角 12px，字体 Noto Sans SC，卡片留白宽松…"
            @input="emit('update:customTokens', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </label>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.design-side-drawer {
  width: 288px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: var(--file-text, #18181b);
  height: 100%;
  overflow: hidden;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
}

.drawer-title {
  font-size: 12px;
  font-weight: 600;
}

.drawer-close-btn {
  border: none;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
}

.drawer-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--file-muted, #71717a);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.tweak-empty {
  border: 1px dashed var(--file-line, #e4e4e7);
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--file-muted, #71717a);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tweak-empty p {
  margin: 0;
  line-height: 1.5;
}

.tweak-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tweak-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #fafafa);
}

.tweak-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
}

.tweak-label {
  font-weight: 600;
  text-transform: capitalize;
}

.tweak-val {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  color: var(--file-muted, #71717a);
}

.tweak-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tweak-color {
  width: 28px;
  height: 24px;
  border: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.tweak-range {
  width: 100%;
  accent-color: var(--file-accent, #2563eb);
}

.tweak-text-input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: inherit;
}

.token-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
  cursor: pointer;
}

.token-notes-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--file-muted, #71717a);
}

.token-notes-input {
  width: 100%;
  resize: vertical;
  font-size: 12px;
  line-height: 1.45;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #fafafa);
  color: inherit;
}

.drawer-mini-btn {
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: inherit;
  cursor: pointer;
}

.drawer-mini-btn.is-primary {
  background: var(--file-accent, #2563eb);
  border-color: var(--file-accent, #2563eb);
  color: #ffffff;
  font-weight: 600;
}
</style>
