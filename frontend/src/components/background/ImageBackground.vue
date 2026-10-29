<!--
  图片背景表面（用户自选主页背景时才注册）。

  <p><b>图片本身不在这里画：</b>它走画布根上的 `background-image: var(--lx-canvas-image, none)`，
  由 `useBackgroundPreference.applyToDocument()` 把 data URL 写进文档根变量。本组件只负责
  <b>可读性遮罩（scrim）</b> —— 任意图片都会打穿气泡对比度，没有遮罩 = 文字看不清。</p>

  <p><b>全部由 CSS 变量驱动，不做主题分支：</b>
   - 遮罩颜色取令牌 `--lx-canvas-scrim`（亮暗两套取值，暗色偏重、亮色偏轻）；
   - 遮罩强度取 `--lx-background-scrim`（0–1，用户在设置页可调），两者相乘即最终不透明度。
  因此这里既不读 isDark，也不在模板里按主题真假分支渲染。</p>
-->
<template>
  <!-- pointer-events-none + absolute inset-0：必须能点穿，绝不能拦住下层交互；aria-hidden：纯装饰 -->
  <div class="lx-image-background__scrim pointer-events-none absolute inset-0" aria-hidden="true"></div>
</template>

<script setup lang="ts">
/**
 * 图片背景的可读性遮罩层。
 *
 * <p>只画 scrim：颜色来自令牌（主题安全），强度来自用户偏好变量（可调）。
 * 组件自身无 props、无状态，因此不存在"两份强度真值"。</p>
 */
</script>

<style scoped>
.lx-image-background__scrim {
  /* 令牌携带主题差异：暗色偏重（压暗图片）、亮色偏轻（提亮图片） */
  background-color: var(--lx-canvas-scrim);
  /* 用户可调强度；未设置时回落到 0.5（默认偏好值见 useBackgroundPreference） */
  opacity: var(--lx-background-scrim, 0.5);
  transition: opacity 320ms ease;
}
</style>
