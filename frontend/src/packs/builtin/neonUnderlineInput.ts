import type {OfficialPackDefinition} from '../types';

/** 极简底线输入栏（输入框扩展包）：弱化外框，聚焦时在底部点亮强调色指示线。 */
export const neonUnderlineInputPack: OfficialPackDefinition = {
  id: 'neon-underline-input',
  cssText: `
[data-slot="chat-input-card"] {
  --pb-radius: 12px;
  border-radius: 12px !important;
  background: color-mix(in srgb, var(--lx-surface-sunken) 84%, transparent) !important;
  border: 1px solid transparent !important;
  border-bottom: 2px solid var(--lx-border-default) !important;
  box-shadow: none !important;
  transition: border-bottom-color 180ms ease, background-color 180ms ease;
}

[data-slot="chat-input-card"]:focus-within {
  border-bottom-color: var(--lx-accent) !important;
  background: var(--lx-surface) !important;
}
`,
};
