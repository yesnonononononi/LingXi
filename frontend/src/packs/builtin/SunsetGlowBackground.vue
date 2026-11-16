<template>
  <!-- 暮光渐变光晕背景：仅消费 --lx-* 语义变量（无 isDark 分支） -->
  <div class="lx-pack-sunset-bg pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div class="lx-pack-sunset-glow-a" />
    <div class="lx-pack-sunset-glow-b" />
  </div>
</template>

<style scoped>
.lx-pack-sunset-bg {
  z-index: 0;
}

.lx-pack-sunset-glow-a {
  position: absolute;
  width: 58vw;
  height: 48vh;
  top: -16vh;
  right: -6vw;
  border-radius: 9999px;
  filter: blur(84px);
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--lx-warning) 24%, transparent) 0%,
    transparent 70%
  );
}

.lx-pack-sunset-glow-b {
  position: absolute;
  width: 54vw;
  height: 44vh;
  bottom: -14vh;
  left: -4vw;
  border-radius: 9999px;
  filter: blur(88px);
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--lx-danger) 18%, transparent) 0%,
    transparent 72%
  );
}
</style>
