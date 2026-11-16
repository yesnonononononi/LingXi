import type {OfficialPackDefinition} from '../types';

/** 绯红赛博（主题皮肤包）：高对比洋红强调色与深邃炭黑/珊瑚白双态配色。 */
export const crimsonNeonPack: OfficialPackDefinition = {
  id: 'crimson-neon',
  cssText: `
:root {
  --lx-canvas: #0c0609;
  --lx-canvas-subtle: #140a0f;
  --lx-surface: #1a0d14;
  --lx-surface-elevated: rgba(30, 14, 22, 0.94);
  --lx-surface-sunken: #12080d;
  --lx-border-subtle: rgba(244, 63, 94, 0.16);
  --lx-border-default: rgba(244, 63, 94, 0.26);
  --lx-border-focus: rgba(251, 113, 133, 0.85);
  --lx-accent: #f43f5e;
  --lx-accent-hover: #fb7185;
  --lx-accent-pressed: #e11d48;
  --lx-accent-soft: rgba(244, 63, 94, 0.18);
}

html.light,
html[data-theme="light"] {
  --lx-canvas: #fff6f8;
  --lx-canvas-subtle: #fdecef;
  --lx-surface: #ffffff;
  --lx-surface-elevated: #ffffff;
  --lx-surface-sunken: #fdf0f3;
  --lx-border-subtle: rgba(225, 29, 72, 0.14);
  --lx-border-default: rgba(225, 29, 72, 0.22);
  --lx-border-focus: rgba(225, 29, 72, 0.80);
  --lx-accent: #e11d48;
  --lx-accent-hover: #f43f5e;
  --lx-accent-pressed: #be123c;
  --lx-accent-soft: rgba(225, 29, 72, 0.11);
}
`,
};
