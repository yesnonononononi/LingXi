import type {PropType, VNodeChild} from 'vue';
import {computed, createVNode, defineComponent, h, onBeforeUnmount, ref, Text, watch} from 'vue';
import type {MarkdownDocument} from '../../utils/markdown';
import {BLUR_REVEAL_DURATION, BlurRevealState} from '../../utils/blurReveal';
import MermaidBlock from './MermaidBlock.vue';

export default defineComponent({
  props: {
    document: { type: Object as PropType<MarkdownDocument>, required: true },
    isDark: Boolean,
    streaming: Boolean,
    revealInitial: Boolean,
  },
  setup(props) {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedMotion = ref(motion.matches);
    const onMotionChange = () => { reducedMotion.value = motion.matches; };
    motion.addEventListener('change', onMotionChange);
    const reveal = new BlurRevealState();
    const revision = ref(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parsed = computed(() => {
      const template = document.createElement('template');
      template.innerHTML = props.document.html;
      const offsets = new Map<Node, number>();
      let text = '';
      const collect = (node: Node): void => {
        if (node instanceof Element && node.matches('.block-toolbar, [data-mermaid-index]')) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent || '';
          // 块间排版空白不是模型文字，否则段落换标签也会触发动画。
          if (!value.trim() && !(node.parentElement?.closest('p, li, code, pre, th, td, h1, h2, h3, h4, h5, h6'))) return;
          offsets.set(node, text.length);
          text += value;
        } else node.childNodes.forEach(collect);
      };
      collect(template.content);
      return { template, offsets, text };
    });
    const scheduleCleanup = (): void => {
      clearTimeout(timer);
      if (!reveal.ranges.length) return;
      const deadline = Math.min(...reveal.ranges.map(range => range.started + BLUR_REVEAL_DURATION));
      timer = setTimeout(() => {
        reveal.expire(performance.now());
        revision.value++;
        scheduleCleanup();
      }, Math.max(1, deadline - performance.now()));
    };
    watch([parsed, () => props.streaming, reducedMotion], () => {
      reveal.update(parsed.value.text, props.streaming && !reducedMotion.value, performance.now(), props.revealInitial);
      revision.value++;
      scheduleCleanup();
    }, { immediate: true, flush: 'sync' });
    onBeforeUnmount(() => {
      clearTimeout(timer);
      reveal.clear();
      motion.removeEventListener('change', onMotionChange);
    });
    return () => {
      void revision.value;
      // 只把净化后的 HTML 转成节点，Vue 才能在流式追加时保留已有图表实例和 SVG。
      const { template, offsets } = parsed.value;
      const toNodes = (node: Node, key: string): VNodeChild[] => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          const offset = offsets.get(node);
          const plain = (value: string, start: number) => createVNode(Text, { key: `${key}-plain-${start}` }, value);
          if (offset === undefined || !reveal.ranges.length) return [plain(text, 0)];
          const children: VNodeChild[] = [];
          let cursor = 0;
          for (const range of reveal.ranges) {
            const start = Math.max(0, range.start - offset);
            const end = Math.min(text.length, range.end - offset);
            if (end <= start) continue;
            if (start > cursor || !children.length) children.push(plain(text.slice(cursor, start), cursor));
            children.push(h('span', {
              key: `reveal-${range.id}-${offset + start}`,
              class: 'blur-reveal',
              onVnodeMounted(vnode) {
                // 高亮或 Markdown 改变父节点时，从原来的进度接续，不能重新淡入。
                const element = vnode.el as HTMLElement;
                for (const animation of element.getAnimations()) {
                  animation.currentTime = Math.min(BLUR_REVEAL_DURATION, performance.now() - range.started);
                }
              },
            }, text.slice(start, end)));
            cursor = end;
          }
          if (cursor < text.length) children.push(plain(text.slice(cursor), cursor));
          return children;
        }
        if (!(node instanceof Element)) return [];
        const index = node.getAttribute('data-mermaid-index');
        const diagram = index === null ? undefined : props.document.diagrams[Number(index)];
        if (diagram) return [h(MermaidBlock, { key: `mermaid-${index}`, ...diagram, isDark: props.isDark })];
        const attributes = Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value]));
        return [h(node.localName, { ...attributes, key }, [...node.childNodes].flatMap((child, i) => toNodes(child, `${key}-${i}`)))];
      };
      return [...template.content.childNodes].flatMap((node, index) => toNodes(node, String(index)));
    };
  },
});
