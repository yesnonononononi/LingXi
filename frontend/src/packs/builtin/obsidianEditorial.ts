import type {OfficialPackDefinition} from '../types';

/**
 * 曜石编辑风（主题皮肤包）：
 * 仅覆盖全局明暗配色与侧边栏/输入框表面质感，可与字体包、背景包自由叠加。
 */
export const obsidianEditorialPack: OfficialPackDefinition = {
  id: 'obsidian-editorial',
  cssText: `
:root {
  --lx-canvas: #0b0a09;
  --lx-canvas-subtle: #12100e;
  --lx-surface: #141210;
  --lx-surface-elevated: rgba(24, 21, 18, 0.94);
  --lx-surface-sunken: #0f0d0b;
  --lx-border-subtle: rgba(217, 178, 110, 0.14);
  --lx-border-default: rgba(217, 178, 110, 0.22);
  --lx-border-focus: rgba(217, 178, 110, 0.78);
  --lx-accent: #d4a359;
  --lx-accent-hover: #e3b975;
  --lx-accent-pressed: #b8873d;
  --lx-accent-soft: rgba(212, 163, 89, 0.14);
}

html.light,
html[data-theme="light"] {
  --lx-canvas: #faf7f2;
  --lx-canvas-subtle: #f3eee5;
  --lx-surface: #fffdf9;
  --lx-surface-elevated: #ffffff;
  --lx-surface-sunken: #f5efe4;
  --lx-border-subtle: rgba(120, 86, 40, 0.14);
  --lx-border-default: rgba(120, 86, 40, 0.22);
  --lx-border-focus: rgba(146, 94, 34, 0.75);
  --lx-accent: #9a5b1e;
  --lx-accent-hover: #b56d27;
  --lx-accent-pressed: #7c4714;
  --lx-accent-soft: rgba(154, 91, 30, 0.10);
}

aside[data-testid="sidebar"],
.sidebar-container {
  background-color: var(--lx-canvas-subtle);
}
`,
};
