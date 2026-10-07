<script setup lang="ts">
/**
 * 打字机粒子拖尾背景。
 *
 * <p>纯视觉组件，不含业务语义。上浮的粒子随输入活跃度变亮变快，用于给输入区「有生命感」。
 * 业务侧唯一的耦合点是 {@link ink}（墨色）与 {@link active}（是否点亮）。</p>
 *
 * <p>关闭时机由外部 {@link active} 控制；组件内部只管画与不画。
 * 用户系统开启「减少动态效果」时自动停画（{@link useReducedMotion}）。</p>
 */
import { ref, watch, onBeforeUnmount, onMounted } from 'vue';
import { useReducedMotion } from 'motion-v';

const props = withDefaults(defineProps<{
  /** 是否点亮特效（通常绑「思考强度拉满」这类状态）。 */
  active?: boolean;
  /** 粒子颜色，CSS 颜色值。 */
  ink?: string;
}>(), {
  active: false,
  ink: '#10b981',
});

/** 单个粒子的运行时状态。 */
interface Spark {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  life: number;
  span: number;
}

/** 输入活跃度：由外部每次输入时抬升，动画循环里按指数衰减。 */
const energy = ref(0);
/** 待消费的输入信号数：每敲一次 +1，循环里消费后清零。 */
let strokes = 0;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const reduce = useReducedMotion();
let stopLoop: (() => void) | null = null;

/** 通知组件「用户敲了一下」，粒子会随之变亮。 */
function ping(): void {
  strokes += 1;
}

function startLoop(): (() => void) | null {
  const canvas = canvasRef.value;
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  strokes = 0;
  let raf = 0;
  let last = performance.now();
  let w = 0;
  let h = 0;
  let due = 0;
  let speed = 1;
  let pulse = 0;
  const parts: Spark[] = [];

  // DPR 感知：画布尺寸按物理像素铺满，绘制按 CSS 像素，交给 setTransform 缩放。
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** burst=true 表示开场铺满全屏，否则从底部升起。 */
  const spawn = (burst: boolean): void => {
    parts.push({
      x: Math.random() * w,
      y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
      r: 0.9 + Math.random() * 1.1,
      vy: -(7 + Math.random() * 9),
      sway: (Math.random() - 0.5) * 10,
      phase: Math.random() * Math.PI * 2,
      life: burst ? Math.random() * 1.2 : 0,
      span: 2.4 + Math.random() * 2.4,
    });
  };

  const tick = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // 能量与脉冲都按指数衰减，保证停止输入后自然平息。
    energy.value *= Math.exp(-dt / 0.8);
    pulse *= Math.exp(-dt / 0.16);
    if (strokes > 0) {
      strokes = 0;
      pulse = 1;
    }
    const gain = 1;
    const current = energy.value * gain;

    speed += (1 + current * 6 - speed) * (1 - Math.exp(-dt / 0.15));

    // 固定节奏往上冒泡，与帧率解耦。
    due += dt;
    while (due > 0.14) {
      due -= 0.14;
      if (parts.length < 30) spawn(false);
    }

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = props.ink;
    ctx.shadowColor = props.ink;
    ctx.shadowBlur = 6 + current * 10 + pulse * 6;

    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.life += dt;
      if (p.life > p.span) {
        parts.splice(i, 1);
        continue;
      }
      const k = p.life / p.span;
      const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + current) + p.phase);
      p.y += p.vy * dt * speed;
      if (p.y < -4) {
        p.y = h + 3;
        p.x = Math.random() * w;
      }
      // 上下边缘淡出，避免粒子硬切入。
      const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
      ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + current * 0.25) * twinkle) * edge;
      ctx.beginPath();
      ctx.arc(
        p.x + Math.sin((now / 900) * (1 + current * 0.8) + p.phase) * p.sway,
        p.y,
        p.r * twinkle * (1 + current * 0.35),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  };

  resize();
  for (let i = 0; i < 26; i += 1) spawn(true);
  // 容器尺寸变化（面板伸缩、窗口缩放）时重算画布，否则粒子会被拉伸。
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    ctx.clearRect(0, 0, w, h);
  };
}

function sync(): void {
  stopLoop?.();
  stopLoop = null;
  if (!props.active || reduce.value) return;
  stopLoop = startLoop();
}

// flush: post 保证 DOM 已更新、canvas 尺寸可测，否则首帧量到 0 宽高。
watch(() => [props.active, reduce.value], sync, { flush: 'post' });

onMounted(sync);

onBeforeUnmount(() => {
  stopLoop?.();
  stopLoop = null;
});

defineExpose({ ping });
</script>

<template>
  <canvas ref="canvasRef" class="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
</template>
