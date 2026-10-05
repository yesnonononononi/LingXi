<script setup lang="ts">
import ConfirmModal from './components/common/ConfirmModal.vue'
import DesktopTitleBar from './components/common/DesktopTitleBar.vue'
import { isElectron } from './utils/platform'

const hasDesktopTitleBar = isElectron() && window.electronAPI?.customTitleBar === true
</script>

<template>
  <div :class="{ 'desktop-shell': hasDesktopTitleBar }">
    <DesktopTitleBar v-if="hasDesktopTitleBar" />
    <main :class="{ 'desktop-content': hasDesktopTitleBar }">
      <router-view />
    </main>
    <ConfirmModal />
  </div>
</template>

<style>
.desktop-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.desktop-shell .h-screen {
  height: calc(100dvh - 36px);
}

.desktop-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.desktop-shell .min-h-screen {
  min-height: calc(100dvh - 36px);
}

/* 全局样式覆盖 */
body {
  margin: 0;
  transition: background-color 420ms ease, color 420ms ease;
}

html.dark body,
body.dark {
  background-color: #000000;
  color: #f4f4f5;
}

html.light body,
body.light {
  background-color: #ffffff;
  color: #111827;
}
</style>
