import type {PropType, VNodeChild} from 'vue';
import {computed, createVNode, defineComponent, h, onBeforeUnmount, ref, Text} from 'vue';
import type {MarkdownDocument} from '../../utils/markdown';
import {TEXT_ARRIVAL_DURATION, ProgressiveFadeState} from '../../utils/progressiveFade';
import MermaidBlock from './MermaidBlock.vue';
import MessageImage from './MessageImage.vue';

const INLINE_TEXT_BLOCK_TAGS = new Set([
  'p', 'li', 'code', 'pre', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

interface TopBlockMeta {
  start: number;
  end: number;
  hasMermaid: boolean;
}

interface CachedBlockVNodes {
  html: string;
  isDark: boolean;
  vnodes: VNodeChild[];
}

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
    const reveal = new ProgressiveFadeState();
    const revision = ref(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const staticBlockCache: (CachedBlockVNodes | undefined)[] = [];
    let lastSyncedParsed: { template: HTMLTemplateElement; offsets: Map<Node, number>; blockMeta: Map<Node, TopBlockMeta>; text: string } | undefined;
    let lastSyncedStreaming: boolean | undefined;
    let lastSyncedReducedMotion: boolean | undefined;

    const parsed = computed(() => {
      const template = document.createElement('template');
      template.innerHTML = props.document.html;
      const offsets = new Map<Node, number>();
      const blockMeta = new Map<Node, TopBlockMeta>();
      let text = '';
      let currentHasMermaid = false;
      const collect = (node: Node, inTextBlock = false): void => {
        if (node instanceof Element) {
          if (node.hasAttribute('data-mermaid-index')) {
            currentHasMermaid = true;
            return;
          }
          if (node.classList.contains('block-toolbar')) return;
          const nextInTextBlock = inTextBlock || INLINE_TEXT_BLOCK_TAGS.has(node.localName);
          for (let child = node.firstChild; child; child = child.nextSibling) {
            collect(child, nextInTextBlock);
          }
          return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent || '';
          // 块间排版空白不是模型文字，否则段落换标签也会触发动画。
          if (!value.trim() && !inTextBlock) return;
          offsets.set(node, text.length);
          text += value;
        } else {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            collect(child, inTextBlock);
          }
        }
      };
      for (let top = template.content.firstChild; top; top = top.nextSibling) {
        const start = text.length;
        currentHasMermaid = false;
        collect(top, false);
        blockMeta.set(top, { start, end: text.length, hasMermaid: currentHasMermaid });
      }
      return { template, offsets, blockMeta, text };
    });

    const scheduleCleanup = (): void => {
      clearTimeout(timer);
      if (!reveal.ranges.length) return;
      // 等当前批次尾迹完整结束后统一回收，避免流式播放中每 16ms 逐片触发整棵树重渲染。
      const deadline = Math.max(...reveal.ranges.map(range => range.started + TEXT_ARRIVAL_DURATION));
      timer = setTimeout(() => {
        reveal.expire(performance.now());
        revision.value++;
        scheduleCleanup();
      }, Math.max(1, deadline - performance.now()));
    };

    onBeforeUnmount(() => {
      clearTimeout(timer);
      reveal.clear();
      staticBlockCache.length = 0;
      motion.removeEventListener('change', onMotionChange);
    });

    return () => {
      void revision.value;
      const currentParsed = parsed.value;
      const isStreaming = Boolean(props.streaming);
      const isReduced = reducedMotion.value;
      if (
        currentParsed !== lastSyncedParsed ||
        isStreaming !== lastSyncedStreaming ||
        isReduced !== lastSyncedReducedMotion
      ) {
        lastSyncedParsed = currentParsed;
        lastSyncedStreaming = isStreaming;
        lastSyncedReducedMotion = isReduced;
        reveal.update(currentParsed.text, isStreaming && !isReduced, performance.now(), props.revealInitial);
        scheduleCleanup();
      }
      // 只把净化后的 HTML 转成节点，Vue 才能在流式追加时保留已有图表实例和 SVG。
      const { template, offsets, blockMeta } = currentParsed;
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
              class: 'codex-text-arrival',
              onVnodeMounted(vnode) {
                // 高亮或 Markdown 改变父节点时，从原来的进度接续，不能重新淡入。
                const element = vnode.el as HTMLElement;
                for (const animation of element.getAnimations()) {
                  animation.currentTime = Math.min(TEXT_ARRIVAL_DURATION, performance.now() - range.started);
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
        if (node.localName === 'img' && node.getAttribute('src')) {
          return [h(MessageImage, {
            key, src: node.getAttribute('src')!, alt: node.getAttribute('alt') || undefined,
            title: node.getAttribute('title') || undefined, isDark: props.isDark, linked: !!node.closest('a'),
          })];
        }
        const attributes = Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value]));
        return [h(node.localName, { ...attributes, key }, [...node.childNodes].flatMap((child, i) => toNodes(child, `${key}-${i}`)))];
      };

      const topNodes = [...template.content.childNodes];
      const dark = Boolean(props.isDark);
      const result = topNodes.flatMap((node, index) => {
        if (!(node instanceof Element)) {
          staticBlockCache[index] = undefined;
          return toNodes(node, String(index));
        }
        const meta = blockMeta.get(node);
        const hasReveal = Boolean(
          meta &&
          meta.end > meta.start &&
          reveal.ranges.some(range => range.start < meta.end && range.end > meta.start)
        );
        // 已定型且不含动态图表的顶层块直接复用 VNode，让 Vue patch 在顶层短路。
        if (!hasReveal && !meta?.hasMermaid) {
          const html = node.outerHTML;
          const cached = staticBlockCache[index];
          if (cached && cached.html === html && cached.isDark === dark) {
            return cached.vnodes;
          }
          const vnodes = toNodes(node, String(index));
          staticBlockCache[index] = { html, isDark: dark, vnodes };
          return vnodes;
        }
        staticBlockCache[index] = undefined;
        return toNodes(node, String(index));
      });
      staticBlockCache.length = topNodes.length;
      return result;
    };
  },
});
