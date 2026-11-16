<template>
  <!-- 工程点阵网格背景：仅消费 --lx-* 语义变量（无 isDark 分支） -->
  <div class="lx-pack-blueprint-grid pointer-events-none absolute inset-0" aria-hidden="true" />
</template>

<style scoped>
.lx-pack-blueprint-grid {
  z-index: 0;
  background-image: radial-gradient(
    color-mix(in srgb, var(--lx-text-faint) 34%, transparent) 1px,
    transparent 1px
  );
  background-size: 22px 22px;
  mask-image: radial-gradient(ellipse 85% 75% at 50% 42%, black 35%, transparent 100%);
}
</style>
