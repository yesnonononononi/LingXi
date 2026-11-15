<script setup lang="ts">
import {onBeforeUnmount, onMounted, provide} from 'vue'
import {useApplicationSessionStore} from './stores/applicationSessionStore'
import ConfirmModal from './components/common/ConfirmModal.vue'
import ContextMenu from './components/common/ContextMenu.vue'
import DesktopTitleBar from './components/common/DesktopTitleBar.vue'
import {isElectron} from './utils/platform'
import {useSettingsSync} from './composables/useSettingsSync'
import {useProjectPagePreview} from './composables/useProjectPagePreview'
import {PROJECT_PAGE_PREVIEW_KEY} from './types/projectPagePreview'

const hasDesktopTitleBar = isElectron() && window.electronAPI?.customTitleBar === true
const applicationSessions = useApplicationSessionStore()
// 设置真源在服务端，多窗口各持一份镜像：挂载时接上「焦点回读 + 广播回读」。
useSettingsSync()
// 浏览器面板具有独立于会话与 ChatView 的应用级生命周期，避免切会话或切路由时销毁已打开的网页。
const pagePreview = useProjectPagePreview()
provide(PROJECT_PAGE_PREVIEW_KEY, pagePreview)

onMounted(() => applicationSessions.start())
onBeforeUnmount(() => applicationSessions.close())
</script>

<template>
  <div :class="{ 'desktop-shell': hasDesktopTitleBar }">
    <DesktopTitleBar v-if="hasDesktopTitleBar" />
    <main :class="{ 'desktop-content': hasDesktopTitleBar }">
      <router-view />
    </main>
    <ConfirmModal />
    <ContextMenu />
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
  overflow-x: hidden;
  overflow-y: auto;
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
