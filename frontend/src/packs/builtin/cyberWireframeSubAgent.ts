import type {OfficialPackDefinition} from '../types';

/**
 * 网格进程条（纯 CSS 极限）：零 JS。子代理协同面板做成工业网格框：
 * 细网格底纹 + 直角 + 等宽成员标签，读起来像机架面板而不是聊天卡片。
 */
export const cyberWireframeSubAgentPack: OfficialPackDefinition = {
  id: 'cyber-wireframe-sub-agent',
  cssText: `
[data-slot="process-sub-agent"] {
  position: relative;
  border-radius: 2px !important;
  border: 1px solid color-mix(in srgb, var(--lx-accent) 34%, var(--lx-border-default)) !important;
  background:
    linear-gradient(
      color-mix(in srgb, var(--lx-accent) 4%, transparent) 1px,
      transparent 1px
    ) 0 0 / 100% 12px,
    var(--lx-surface-sunken) !important;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) !important;
  box-shadow: none !important;
  padding: 0 !important;
}

/* 四个角上画 L 形角标：工业面板的标志性细节，纯 CSS 零成本 */
[data-slot="process-sub-agent"]::before,
[data-slot="process-sub-agent"]::after {
  content: "";
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1px solid var(--lx-accent);
  opacity: 0.65;
  pointer-events: none;
}

[data-slot="process-sub-agent"]::before {
  top: -1px;
  inset-inline-start: -1px;
  border-right: 0;
  border-bottom: 0;
}

[data-slot="process-sub-agent"]::after {
  bottom: -1px;
  inset-inline-end: -1px;
  border-left: 0;
  border-top: 0;
}

/* 成员按钮：直角、等宽、悬停左移导轨 */
[data-slot="process-sub-agent"] button {
  border-radius: 2px !important;
  border: 1px solid var(--lx-border-subtle) !important;
  background: color-mix(in srgb, var(--lx-surface) 88%, transparent) !important;
  font-family: inherit !important;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

[data-slot="process-sub-agent"] button:hover {
  border-color: var(--lx-accent) !important;
  transform: translateX(2px);
}
`,
};
