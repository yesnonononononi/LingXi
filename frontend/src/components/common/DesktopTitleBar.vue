<script setup lang="ts">
import { watch } from 'vue';
import { useTheme } from '../../composables/useTheme';
import logoUrl from '../../assets/lingxi-agent-logo.png';

const { isDark } = useTheme();
const isMac = window.electronAPI?.platform === 'darwin';

watch(isDark, value => {
  void window.electronAPI?.setTitleBarTheme?.(value).catch(error => {
    console.warn('同步标题栏主题失败:', error);
  });
}, { immediate: true });
</script>

<template>
  <header class="desktop-titlebar" :class="{ 'is-light': !isDark, 'is-mac': isMac }">
    <div class="titlebar-content">
      <img :src="logoUrl" alt="" class="titlebar-logo" draggable="false" />
      <span class="titlebar-name">LX</span>
      <span class="titlebar-divider" aria-hidden="true"></span>
      <span class="titlebar-caption">灵犀 · 智能体工作台</span>
    </div>
  </header>
</template>

<style scoped>
.desktop-titlebar {
  height: 36px;
  flex-shrink: 0;
  color: #a1a1aa;
  background: #09090b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  user-select: none;
  -webkit-app-region: drag;
}

.titlebar-content {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 100%;
  margin-left: env(titlebar-area-x, 0px);
  width: env(titlebar-area-width, calc(100% - 150px));
  padding: 0 14px;
  overflow: hidden;
  white-space: nowrap;
}

.titlebar-logo {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.titlebar-name {
  color: #e4e4e7;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.titlebar-divider {
  width: 1px;
  height: 11px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.12);
}

.titlebar-caption {
  overflow: hidden;
  text-overflow: ellipsis;
  color: #71717a;
  font-size: 11px;
  letter-spacing: 0.03em;
}

.is-light {
  background: #f5f5f7;
  border-bottom-color: rgba(0, 0, 0, 0.07);
}

.is-light .titlebar-name {
  color: #27272a;
}

.is-light .titlebar-divider {
  background: rgba(0, 0, 0, 0.12);
}

.is-light .titlebar-caption {
  color: #71717a;
}

.is-mac .titlebar-content {
  padding-left: 80px;
}
</style>
