<template>
  <!-- 极光氛围背景表面：仅消费 --lx-* 语义变量（无 isDark 分支），叠在宿主画布之上 -->
  <div class="lx-pack-aurora-bg pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div class="lx-pack-aurora-ribbon" />
    <div class="lx-pack-aurora-orb lx-pack-aurora-orb-1" />
    <div class="lx-pack-aurora-orb lx-pack-aurora-orb-2" />
    <div class="lx-pack-aurora-orb lx-pack-aurora-orb-3" />
  </div>
</template>

<style scoped>
.lx-pack-aurora-bg {
  z-index: 0;
}

.lx-pack-aurora-ribbon {
  position: absolute;
  inset: -20% -10% auto -10%;
  height: 62%;
  background: linear-gradient(
    115deg,
    transparent 12%,
    color-mix(in srgb, var(--lx-accent) 22%, transparent) 38%,
    color-mix(in srgb, var(--lx-info) 18%, transparent) 62%,
    transparent 88%
  );
  filter: blur(64px);
  opacity: 0.85;
  transform: rotate(-6deg);
}

.lx-pack-aurora-orb {
  position: absolute;
  border-radius: 9999px;
  filter: blur(72px);
}

.lx-pack-aurora-orb-1 {
  width: 46vw;
  height: 42vh;
  top: -10vh;
  left: 16vw;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--lx-accent) 30%, transparent) 0%,
    transparent 70%
  );
  animation: lx-aurora-drift 16s ease-in-out infinite alternate;
}

.lx-pack-aurora-orb-2 {
  width: 42vw;
  height: 38vh;
  top: 8vh;
  right: 6vw;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--lx-info) 24%, transparent) 0%,
    transparent 70%
  );
  animation: lx-aurora-drift 20s ease-in-out infinite alternate-reverse;
}

.lx-pack-aurora-orb-3 {
  width: 38vw;
  height: 32vh;
  bottom: -8vh;
  left: 30vw;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--lx-success) 16%, transparent) 0%,
    transparent 72%
  );
}

@keyframes lx-aurora-drift {
  0% {
    transform: translate3d(0, 0, 0) scale(1);
  }
  100% {
    transform: translate3d(28px, 16px, 0) scale(1.06);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lx-pack-aurora-orb-1,
  .lx-pack-aurora-orb-2 {
    animation: none;
  }
}
</style>
