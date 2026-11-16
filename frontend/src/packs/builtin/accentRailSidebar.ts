import type {OfficialPackDefinition} from '../types';

/** 强调色导轨边栏（侧边栏扩展包）：在左侧边缘增加强调色细光导轨，增强空间锚定感。 */
export const accentRailSidebarPack: OfficialPackDefinition = {
  id: 'accent-rail-sidebar',
  cssText: `
aside.border-r {
  box-shadow: inset 3px 0 0 0 var(--lx-accent);
  background-color: var(--lx-canvas-subtle) !important;
}
`,
};
