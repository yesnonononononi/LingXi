import type {OfficialPackDefinition} from '../types';

/**
 * 书卷衬线字体包（字体扩展包）：
 * 覆写正文字体族与代码块等宽字体族，独立于主题配色生效。
 */
export const editorialSerifFontPack: OfficialPackDefinition = {
  id: 'editorial-serif-font',
  cssText: `
:root {
  --font-sans: 'Georgia', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', ui-serif, serif;
  --font-lx-code: 'Fira Code', 'JetBrains Mono', 'Cascadia Mono', ui-monospace, monospace;
}

body {
  font-family: var(--font-sans);
}
`,
};
