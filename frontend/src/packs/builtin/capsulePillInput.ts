import type {OfficialPackDefinition} from '../types';

/** 悬浮胶囊输入栏（输入框扩展包）：28px 超大圆角 + 柔和立体浮起阴影。 */
export const capsulePillInputPack: OfficialPackDefinition = {
  id: 'capsule-pill-input',
  cssText: `
[data-slot="chat-input-card"] {
  --pb-radius: 28px;
  border-radius: 28px !important;
  background: var(--lx-surface-elevated) !important;
  border: 1px solid var(--lx-border-subtle) !important;
  box-shadow: var(--lx-shadow-3);
  padding: 14px 16px !important;
}

[data-slot="chat-input-card"]:focus-within {
  border-color: var(--lx-border-strong) !important;
}
`,
};
