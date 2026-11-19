import type {OfficialPackDefinition} from '../types';

/**
 * 虚线终端思考（纯 CSS 极限）：零 JS。思考区做成一条虚线下沉带，
 * 左侧用信息色导轨标示「这里是模型自述，不是给你的答复」。
 */
export const cyberWireframeThoughtPack: OfficialPackDefinition = {
  id: 'cyber-wireframe-thought',
  cssText: `
[data-slot="process-thought"] {
  position: relative;
  border-radius: 2px !important;
  border: 1px dashed color-mix(in srgb, var(--lx-info) 48%, var(--lx-border-default)) !important;
  background:
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--lx-info) 4%, transparent) 0 1px,
      transparent 1px 6px
    ),
    var(--lx-surface-sunken) !important;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) !important;
  box-shadow: none !important;
}

[data-slot="process-thought"]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 2px;
  background: var(--lx-info);
  opacity: 0.75;
}

/*
 * 标题行角标：把「自述」这件事写在行首。基础渲染器的标题按钮是 inline-flex，
 * ::before 会作为第一个 flex item 落在箭头之前，不依赖内部层级。
 */
[data-slot="process-thought"] > button::before {
  content: "THINK";
  flex-shrink: 0;
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--lx-info);
  border: 1px solid color-mix(in srgb, var(--lx-info) 45%, transparent);
  border-radius: 2px;
  padding: 0 4px;
}

[data-slot="process-thought"] .markdown-body {
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.7;
  color: var(--lx-text-secondary);
}
`,
};
