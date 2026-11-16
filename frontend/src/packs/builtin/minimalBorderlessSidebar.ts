import type {OfficialPackDefinition} from '../types';

/** 极简无界边栏（侧边栏扩展包）：去掉右侧分割线，使侧边栏柔和融入主画布。 */
export const minimalBorderlessSidebarPack: OfficialPackDefinition = {
  id: 'minimal-borderless-sidebar',
  cssText: `
aside.border-r {
  border-right-color: transparent !important;
  background-color: color-mix(in srgb, var(--lx-canvas) 65%, transparent) !important;
  backdrop-filter: blur(10px);
}
`,
};
