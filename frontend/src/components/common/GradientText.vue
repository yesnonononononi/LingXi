<script setup lang="ts">
import { Motion, useAnimationFrame, useMotionValue, useTransform } from 'motion-v';
import { computed, ref, useSlots } from 'vue';

interface GradientTextProps {
  className?: string;
  colors?: string[];
  animationSpeed?: number;
  showBorder?: boolean;
  direction?: 'horizontal' | 'vertical' | 'diagonal';
  pauseOnHover?: boolean;
  yoyo?: boolean;
}

const props = withDefaults(defineProps<GradientTextProps>(), {
  className: '',
  colors: () => ['#27FF64', '#27FF64', '#A0FFBC'],
  animationSpeed: 8,
  showBorder: false,
  direction: 'horizontal',
  pauseOnHover: false,
  yoyo: true
});

const slots = useSlots();
const text = computed(() => (slots.default?.() ?? []).map(v => typeof v.children === 'string' ? v.children : '').join(''));

const isPaused = ref(false);
const progress = useMotionValue(0);
const elapsedRef = ref(0);
const lastTimeRef = ref<number | null>(null);

const animationDuration = props.animationSpeed * 1000;

useAnimationFrame(time => {
  if (isPaused.value) {
    lastTimeRef.value = null;
    return;
  }

  if (lastTimeRef.value === null) {
    lastTimeRef.value = time;
    return;
  }

  const deltaTime = time - lastTimeRef.value;
  lastTimeRef.value = time;
  elapsedRef.value += deltaTime;

  if (props.yoyo) {
    const fullCycle = animationDuration * 2;
    const cycleTime = elapsedRef.value % fullCycle;

    if (cycleTime < animationDuration) {
      progress.set((cycleTime / animationDuration) * 100);
    } else {
      progress.set(100 - ((cycleTime - animationDuration) / animationDuration) * 100);
    }
  } else {
    progress.set((elapsedRef.value / animationDuration) * 100);
  }
});

const backgroundPosition = useTransform(progress, p => {
  if (props.direction === 'horizontal') {
    return `${p}% 50%`;
  } else if (props.direction === 'vertical') {
    return `50% ${p}%`;
  } else {
    return `${p}% 50%`;
  }
});

const handleMouseEnter = () => {
  if (props.pauseOnHover) isPaused.value = true;
};

const handleMouseLeave = () => {
  if (props.pauseOnHover) isPaused.value = false;
};

const gradientAngle = computed(() =>
  props.direction === 'horizontal' ? 'to right' : props.direction === 'vertical' ? 'to bottom' : 'to bottom right'
);

const gradientColors = computed(() => [...props.colors, props.colors[0]].join(', '));

const gradientStyle = computed(() => ({
  backgroundImage: `linear-gradient(${gradientAngle.value}, ${gradientColors.value})`,
  backgroundSize:
    props.direction === 'horizontal' ? '300% 100%' : props.direction === 'vertical' ? '100% 300%' : '300% 300%',
  backgroundRepeat: 'repeat'
}));
</script>

<template>
  <Motion
    tag="div"
    :class="[
      'relative inline-flex max-w-fit flex-row items-center justify-start rounded-[1.25rem] font-medium backdrop-blur transition-shadow duration-500 cursor-pointer',
      showBorder ? 'overflow-hidden py-1 px-2' : 'px-1 py-0.5',
      className
    ]"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <Motion
      tag="div"
      v-if="showBorder"
      class="z-0 absolute inset-0 rounded-[1.25rem] pointer-events-none"
      :style="{ ...gradientStyle, backgroundPosition }"
    >
      <div
        class="z-[-1] absolute bg-black rounded-[1.25rem]"
        :style="{
          width: 'calc(100% - 2px)',
          height: 'calc(100% - 2px)',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)'
        }"
      />
    </Motion>

    <Motion
      tag="div"
      class="inline-block z-2 relative bg-clip-text text-transparent px-0.5"
      :style="{
        ...gradientStyle,
        backgroundPosition,
        WebkitBackgroundClip: 'text'
      }"
    >
      <slot>{{ text }}</slot>
    </Motion>
  </Motion>
</template>
