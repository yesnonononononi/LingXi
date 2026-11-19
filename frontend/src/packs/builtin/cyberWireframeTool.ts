import type {OfficialPackDefinition} from '../types';

/**
 * 线框指令行（纯 CSS 极限）：零 JS。工具调用行转成一条等宽指令记录：
 * 直角、沉降底、悬停亮起左侧导轨，标题里的工具名用强调色标识。
 */
export const cyberWireframeToolPack: OfficialPackDefinition = {
  id: 'cyber-wireframe-tool',
  cssText: `
[data-slot="process-tool"] {
  position: relative;
  border-radius: 2px !important;
  border: 1px solid var(--lx-border-subtle) !important;
  background: var(--lx-surface-sunken) !important;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) !important;
  transition: border-color 0.15s ease;
}

[data-slot="process-tool"]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 2px;
  background: var(--lx-accent);
  opacity: 0;
  transition: opacity 0.15s ease;
}

[data-slot="process-tool"]:hover {
  border-color: color-mix(in srgb, var(--lx-accent) 42%, var(--lx-border-default)) !important;
}

[data-slot="process-tool"]:hover::before {
  opacity: 0.9;
}

/*
 * 工具调用行的基础 DOM 由 ToolCallRenderer 拥有（图标 + 分类名 + 目标 + 徽章），
 * 结构细节不适合用 nth-child 猜。这里只做整体层面的等宽与直角，工具名着色交给
 * 悬停导轨承担，避免选择器随渲染器演进而失效。
 */
[data-slot="process-tool"] {
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) !important;
  letter-spacing: 0.01em;
}

/* 详情抽屉里的输出块：直角、细线，别再用圆角浅底 */
[data-slot="process-tool"] pre,
[data-slot="process-tool"] [class*="max-h-64"] {
  border-radius: 2px !important;
}
`,
};
