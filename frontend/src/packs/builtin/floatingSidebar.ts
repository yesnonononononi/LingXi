import type {OfficialPackDefinition} from '../types';
import FloatingSidebarFooter from './FloatingSidebarFooter.vue';

/**
 * 悬浮玻璃侧边栏（侧边栏扩展包）：
 * 将侧边栏改造为圆角悬浮毛玻璃卡片样式，并替换 SIDEBAR_SLOTS_KEY.sidebarFooter 为胶囊底栏组件。
 */
export const floatingSidebarPack: OfficialPackDefinition = {
  id: 'floating-sidebar',
  slots: {
    sidebar: {
      sidebarFooter: FloatingSidebarFooter,
    },
  },
  cssText: `
/* 悬浮圆角毛玻璃侧边栏 */
aside.border-r {
  margin: 8px 0 8px 8px;
  height: calc(100% - 16px) !important;
  border-radius: 18px;
  border: 1px solid var(--lx-border-subtle) !important;
  background-color: color-mix(in srgb, var(--lx-surface) 82%, transparent) !important;
  backdrop-filter: blur(18px);
  box-shadow: var(--lx-shadow-2);
}
`,
};
