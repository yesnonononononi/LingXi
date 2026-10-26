import { defineComponent, h } from 'vue';
import type { PropType, VNodeChild } from 'vue';
import type { MarkdownDocument } from '../../utils/markdown';
import MermaidBlock from './MermaidBlock.vue';

export default defineComponent({
  props: {
    document: { type: Object as PropType<MarkdownDocument>, required: true },
    isDark: Boolean,
  },
  setup(props) {
    return () => {
      // 只把净化后的 HTML 转成节点，Vue 才能在流式追加时保留已有图表实例和 SVG。
      const template = document.createElement('template');
      template.innerHTML = props.document.html;
      const toNode = (node: Node, key: string): VNodeChild => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (!(node instanceof Element)) return null;
        const index = node.getAttribute('data-mermaid-index');
        const diagram = index === null ? undefined : props.document.diagrams[Number(index)];
        if (diagram) return h(MermaidBlock, { key: `mermaid-${index}`, ...diagram, isDark: props.isDark });
        const attributes = Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value]));
        return h(node.localName, { ...attributes, key }, [...node.childNodes].map((child, i) => toNode(child, `${key}-${i}`)));
      };
      return [...template.content.childNodes].map((node, index) => toNode(node, String(index)));
    };
  },
});
