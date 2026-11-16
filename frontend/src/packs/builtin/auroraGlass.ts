import type {OfficialPackDefinition} from '../types';
import AuroraBackground from './AuroraBackground.vue';

/**
 * 极光氛围背景（主页背景包）：
 * 替换 BACKGROUND_SLOTS_KEY.surface 为动态极光表面，并补充柔和环境光变量。
 */
export const auroraGlassPack: OfficialPackDefinition = {
  id: 'aurora-glass',
  slots: {
    background: {
      surface: AuroraBackground,
    },
  },
  cssText: `
:root {
  --lx-info-soft: rgba(56, 189, 248, 0.18);
}

html.light,
html[data-theme="light"] {
  --lx-info-soft: rgba(14, 165, 233, 0.14);
}
`,
};
