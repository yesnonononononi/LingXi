import {onBeforeUnmount, ref, watch} from 'vue';
import {ThinkingTextScheduler} from '../utils/thinkingTextScheduler';

/** 初次挂载直接展示快照，仅对之后追加的思考文字进行有界追赶。 */
export function useThinkingText(source: () => string, enabled: () => boolean) {
  const scheduler = new ThinkingTextScheduler(source(), performance.now());
  const content = ref(scheduler.content);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = ref(motion.matches);
  let frame: number | undefined;
  let disposed = false;

  const cancel = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const advance = (now: number): void => {
    frame = undefined;
    if (disposed) return;
    if (scheduler.advance(now)) content.value = scheduler.content;
    if (scheduler.pending) frame = requestAnimationFrame(advance);
  };
  const onMotionChange = (): void => { reducedMotion.value = motion.matches; };
  const onVisibilityChange = (): void => {
    if (!document.hidden) return;
    scheduler.receive(source(), false, performance.now());
    content.value = scheduler.content;
    cancel();
  };
  motion.addEventListener('change', onMotionChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  watch([source, enabled, reducedMotion], ([text, live, reduced]) => {
    scheduler.receive(text, live && !reduced && !document.hidden, performance.now());
    content.value = scheduler.content;
    if (!scheduler.pending) cancel();
    else if (frame === undefined) frame = requestAnimationFrame(advance);
  }, { immediate: true, flush: 'sync' });
  onBeforeUnmount(() => {
    disposed = true;
    cancel();
    scheduler.dispose();
    motion.removeEventListener('change', onMotionChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });
  return content;
}
