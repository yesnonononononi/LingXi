<script setup lang="ts">
import ConfirmModal from './components/common/ConfirmModal.vue'
</script>

<template>
  <div>
    <router-view />
    <ConfirmModal />
  </div>
</template>

<style>
/* 全局样式覆盖 */
body {
  margin: 0;
  background-color: #000000;
  transition: background-color 420ms ease;
}

/* 亮色模式下页面底色，避免超出视口时露出黑底 */
html.light body {
  background-color: #ffffff;
}
</style>
