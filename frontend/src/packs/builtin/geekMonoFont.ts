import type {OfficialPackDefinition} from '../types';

/** 极客等宽体（字体扩展包）：全局采用等宽技术字体栈，适合代码密集型对话。 */
export const geekMonoFontPack: OfficialPackDefinition = {
  id: 'geek-mono-font',
  cssText: `
:root {
  --font-sans: 'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'Consolas', ui-monospace, monospace;
  --font-lx-code: 'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'Consolas', ui-monospace, monospace;
}

body {
  font-family: var(--font-sans);
  letter-spacing: -0.01em;
}
`,
};
