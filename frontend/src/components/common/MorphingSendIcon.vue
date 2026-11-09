<script setup lang="ts">
/**
 * 发送按钮图标变形动画：上箭头 ↔ 停止方块。
 *
 * <p>两个 SVG 路径之间做线性插值，由 {@link isSending} 驱动自动来回切换。
 * 纯视觉组件，不感知业务——「什么时候该变成停止」由调用方决定。</p>
 */
import {onBeforeUnmount, ref, watch} from 'vue';
import {animate, type AnimationPlaybackControls, motionValue, useReducedMotion} from 'motion-v';

/** 上箭头轮廓坐标（viewBox 24x24，成对 x,y）。 */
const ARROW_UP = [12, 4.2, 18.4, 10.6, 13.5, 10.6, 13.5, 19.8, 10.5, 19.8, 10.5, 10.6, 5.6, 10.6];
/** 停止方块轮廓坐标。 */
const SQUARE = [12, 6.5, 17.5, 6.5, 17.5, 12, 17.5, 17.5, 6.5, 17.5, 6.5, 12, 6.5, 6.5];
/** 与原实现一致的缓动：先快后慢的强对比曲线。 */
const EASE_IN_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const props = withDefaults(defineProps<{
  /** true 显示停止方块，false 显示上箭头。 */
  isSending?: boolean;
  /** 图标路径的 stroke 颜色。 */
  color?: string;
}>(), {
  isSending: false,
  color: 'currentColor',
});

const emit = defineEmits<{ (e: 'click'): void }>();

const svgRef = ref<SVGSVGElement | null>(null);
const pathRef = ref<SVGPathElement | null>(null);
const reduce = useReducedMotion();

/** 插值进度：0 = 箭头，1 = 方块。 */
const progress = motionValue(props.isSending ? 1 : 0);
/** 变形方向：进入停止态为 1，返回箭头为 -1，决定过冲旋转的方向。 */
let direction = props.isSending ? 1 : -1;
let controls: AnimationPlaybackControls | null = null;
let offChange: (() => void) | undefined;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 在两条同点数轮廓间插值出 path 的 d 属性。 */
function pathAt(a: number[], b: number[], t: number): string {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
}

function sync(): void {
  const target = props.isSending ? 1 : 0;
  direction = props.isSending ? 1 : -1;
  if (progress.get() === target) return;
  controls?.stop();
  // 减少动态效果时直接跳到目标态，不播放过渡。
  controls = animate(
    progress,
    target,
    reduce.value ? { duration: 0 } : { duration: 0.26, ease: EASE_IN_OUT },
  );
}

watch(() => props.isSending, sync, { immediate: true });

/**
 * 每帧把插值写进 path 的 d，并让整个图标随进度做轻微的挤压+旋转。
 *
 * <p>中途（0.5 附近）缩放最剧烈、起止两端归零，于是观感上是「弹一下」而非匀速缩放。</p>
 */
offChange = progress.on('change', (value) => {
  pathRef.value?.setAttribute('d', pathAt(ARROW_UP, SQUARE, value));
  const goo = reduce.value ? 0 : Math.sin(value * Math.PI);
  const scaleX = 1 - 0.14 * goo;
  const scaleY = 1 - 0.08 * goo;
  if (svgRef.value) {
    svgRef.value.style.transform = goo
      ? `rotate(${direction * 10 * goo}deg) scale(${scaleX}, ${scaleY})`
      : '';
  }
});

onBeforeUnmount(() => {
  offChange?.();
  controls?.stop();
});
</script>

<template>
  <svg
    ref="svgRef"
    viewBox="0 0 24 24"
    width="14"
    height="14"
    aria-hidden="true"
    fill="currentColor"
    stroke="currentColor"
    :stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="block w-3.5 h-3.5 origin-center"
    :style="{ color }"
    @click="emit('click')"
  >
    <path ref="pathRef" :d="pathAt(ARROW_UP, SQUARE, progress.get())" />
  </svg>
</template>
