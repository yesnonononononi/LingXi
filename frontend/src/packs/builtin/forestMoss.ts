import type {OfficialPackDefinition} from '../types';

/** 森系松苔（主题皮肤包）：低饱和护眼森林绿与暖米白双态配色。 */
export const forestMossPack: OfficialPackDefinition = {
  id: 'forest-moss',
  cssText: `
:root {
  --lx-canvas: #070d0a;
  --lx-canvas-subtle: #0c1510;
  --lx-surface: #101c15;
  --lx-surface-elevated: rgba(18, 31, 24, 0.94);
  --lx-surface-sunken: #0a130e;
  --lx-border-subtle: rgba(74, 222, 128, 0.14);
  --lx-border-default: rgba(74, 222, 128, 0.22);
  --lx-border-focus: rgba(52, 211, 153, 0.80);
  --lx-accent: #10b981;
  --lx-accent-hover: #34d399;
  --lx-accent-pressed: #059669;
  --lx-accent-soft: rgba(16, 185, 129, 0.16);
}

html.light,
html[data-theme="light"] {
  --lx-canvas: #f4f8f5;
  --lx-canvas-subtle: #eaf2ec;
  --lx-surface: #ffffff;
  --lx-surface-elevated: #ffffff;
  --lx-surface-sunken: #edf4ef;
  --lx-border-subtle: rgba(5, 150, 105, 0.14);
  --lx-border-default: rgba(5, 150, 105, 0.22);
  --lx-border-focus: rgba(5, 150, 105, 0.82);
  --lx-accent: #059669;
  --lx-accent-hover: #10b981;
  --lx-accent-pressed: #047857;
  --lx-accent-soft: rgba(5, 150, 105, 0.12);
}
`,
};
