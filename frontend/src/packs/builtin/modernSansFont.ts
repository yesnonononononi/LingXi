import type {OfficialPackDefinition} from '../types';

/** 现代清雅体（字体扩展包）：清爽几何无衬线字体栈，优化中英文混排观感。 */
export const modernSansFontPack: OfficialPackDefinition = {
  id: 'modern-sans-font',
  cssText: `
:root {
  --font-sans: 'Inter', 'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei UI', ui-sans-serif, system-ui, sans-serif;
  --font-lx-code: 'Cascadia Code', 'JetBrains Mono', 'Consolas', ui-monospace, monospace;
}

body {
  font-family: var(--font-sans);
}
`,
};
