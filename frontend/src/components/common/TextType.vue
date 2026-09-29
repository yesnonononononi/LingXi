<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, useTemplateRef } from 'vue';
import { gsap } from 'gsap';

interface TextTypeProps {
  className?: string;
  showCursor?: boolean;
  hideCursorWhileTyping?: boolean;
  hideCursorOnComplete?: boolean;
  cursorCharacter?: string;
  cursorBlinkDuration?: number;
  cursorClassName?: string;
  text: string | string[];
  as?: string;
  typingSpeed?: number;
  initialDelay?: number;
  pauseDuration?: number;
  deletingSpeed?: number;
  loop?: boolean;
  textColors?: string[];
  variableSpeed?: { min: number; max: number };
  onSentenceComplete?: (sentence: string, index: number) => void;
  startOnVisible?: boolean;
  reverseMode?: boolean;
}

const props = withDefaults(defineProps<TextTypeProps>(), {
  as: 'div',
  typingSpeed: 50,
  initialDelay: 0,
  pauseDuration: 2000,
  deletingSpeed: 30,
  loop: true,
  className: '',
  showCursor: true,
  hideCursorWhileTyping: false,
  hideCursorOnComplete: true,
  cursorCharacter: '|',
  cursorBlinkDuration: 0.5,
  textColors: () => [],
  startOnVisible: false,
  reverseMode: false
});

const displayedText = ref('');
const currentCharIndex = ref(0);
const isDeleting = ref(false);
const currentTextIndex = ref(0);
const isVisible = ref(!props.startOnVisible);
const isFinished = ref(false);
const cursorRef = useTemplateRef<HTMLElement>('cursorRef');
const containerRef = useTemplateRef<HTMLElement>('containerRef');

const textArray = computed(() => (Array.isArray(props.text) ? props.text : [props.text]));

const getRandomSpeed = () => {
  if (!props.variableSpeed) return props.typingSpeed;
  const { min, max } = props.variableSpeed;
  return Math.random() * (max - min) + min;
};

const getCurrentTextColor = () => {
  if (!props.textColors.length) return undefined;
  return props.textColors[currentTextIndex.value % props.textColors.length];
};

let timeout: ReturnType<typeof setTimeout> | null = null;

const clearTimeoutIfNeeded = () => {
  if (timeout) clearTimeout(timeout);
};

const onTypingComplete = () => {
  isFinished.value = true;
  if (props.showCursor && cursorRef.value) {
    if (props.hideCursorOnComplete) {
      // 闪烁一次后淡出，避免无休止一直闪烁
      gsap.killTweensOf(cursorRef.value);
      gsap.to(cursorRef.value, {
        opacity: 0,
        duration: props.cursorBlinkDuration,
        repeat: 1,
        yoyo: true,
        ease: 'power2.inOut',
        onComplete: () => {
          if (cursorRef.value) {
            gsap.to(cursorRef.value, { opacity: 0, duration: 0.25 });
          }
        }
      });
    }
  }
};

const executeTypingAnimation = () => {
  if (isFinished.value) return;
  const currentText = textArray.value[currentTextIndex.value];
  if (!currentText && currentText !== '') return;
  const processedText = props.reverseMode ? currentText.split('').reverse().join('') : currentText;

  if (isDeleting.value) {
    if (displayedText.value === '') {
      isDeleting.value = false;
      if (currentTextIndex.value === textArray.value.length - 1 && !props.loop) {
        onTypingComplete();
        return;
      }

      props.onSentenceComplete?.(textArray.value[currentTextIndex.value], currentTextIndex.value);

      currentTextIndex.value = (currentTextIndex.value + 1) % textArray.value.length;
      currentCharIndex.value = 0;
      timeout = setTimeout(() => {
        executeTypingAnimation();
      }, props.pauseDuration);
    } else {
      timeout = setTimeout(() => {
        displayedText.value = displayedText.value.slice(0, -1);
      }, props.deletingSpeed);
    }
  } else {
    if (currentCharIndex.value < processedText.length) {
      timeout = setTimeout(
        () => {
          displayedText.value += processedText[currentCharIndex.value];
          currentCharIndex.value += 1;
        },
        props.variableSpeed ? getRandomSpeed() : props.typingSpeed
      );
    } else {
      // 当前句子输入完毕
      props.onSentenceComplete?.(textArray.value[currentTextIndex.value], currentTextIndex.value);

      const isLastSentence = currentTextIndex.value === textArray.value.length - 1;
      if (!props.loop && isLastSentence) {
        // 单次模式：输入完成直接收尾，不进入删除循环
        onTypingComplete();
      } else if (textArray.value.length > 1 || props.loop) {
        timeout = setTimeout(() => {
          isDeleting.value = true;
        }, props.pauseDuration);
      } else {
        onTypingComplete();
      }
    }
  }
};

watch(
  [displayedText, currentCharIndex, isDeleting, isVisible],
  () => {
    if (!isVisible.value || isFinished.value) return;
    clearTimeoutIfNeeded();

    if (currentCharIndex.value === 0 && !isDeleting.value && displayedText.value === '') {
      timeout = setTimeout(() => {
        executeTypingAnimation();
      }, props.initialDelay);
    } else {
      executeTypingAnimation();
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (props.showCursor && cursorRef.value) {
    gsap.set(cursorRef.value, { opacity: 1 });
    gsap.to(cursorRef.value, {
      opacity: 0,
      duration: props.cursorBlinkDuration,
      repeat: -1,
      yoyo: true,
      ease: 'power2.inOut'
    });
  }

  if (props.startOnVisible && containerRef.value) {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) isVisible.value = true;
        });
      },
      { threshold: 0.1 }
    );
    if (containerRef.value instanceof Element) {
      observer.observe(containerRef.value);
    }
    onBeforeUnmount(() => observer.disconnect());
  }
});

onBeforeUnmount(() => {
  clearTimeoutIfNeeded();
  if (cursorRef.value) {
    gsap.killTweensOf(cursorRef.value);
  }
});
</script>

<template>
  <component
    :is="as"
    ref="containerRef"
    :class="`inline-block whitespace-pre-wrap tracking-tight ${className}`"
    v-bind="$attrs"
  >
    <span class="inline" :style="getCurrentTextColor() ? { color: getCurrentTextColor() } : undefined">
      {{ displayedText }}
    </span>
    <span
      v-if="showCursor"
      ref="cursorRef"
      :class="`ml-0.5 inline-block opacity-100 ${
        hideCursorWhileTyping && (currentCharIndex < (textArray[currentTextIndex]?.length ?? 0) || isDeleting) ? 'hidden' : ''
      } ${cursorClassName}`"
    >
      {{ cursorCharacter }}
    </span>
  </component>
</template>
