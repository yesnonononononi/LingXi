import type {OfficialPackDefinition} from '../types';

/**
 * 赛博线框输入（纯 CSS 极限）：零 JS，只靠 `data-slot` 锚点把用户气泡重画成一张
 * 工业指令牌——直角、双线框、左侧强调导轨与 `USER_INPUT` 角标。
 */
export const cyberWireframeUserMessagePack: OfficialPackDefinition = {
  id: 'cyber-wireframe-user-message',
  cssText: `
[data-slot="user-message-bubble"] {
  position: relative;
  border-radius: 2px !important;
  border: 1px solid color-mix(in srgb, var(--lx-accent) 42%, var(--lx-border-default)) !important;
  outline: 1px solid color-mix(in srgb, var(--lx-accent) 14%, transparent);
  outline-offset: 2px;
  background:
    repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--lx-accent) 5%, transparent) 0 1px,
      transparent 1px 7px
    ),
    var(--lx-surface-sunken) !important;
  color: var(--lx-text-primary) !important;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  box-shadow: none !important;
  padding: 10px 12px 10px 16px !important;
}

/* 左侧导轨：线框系列的统一身份，用户消息用强调色 */
[data-slot="user-message-bubble"]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 3px;
  background: var(--lx-accent);
}

/* 角标：直角小标签，压在左上角外框线上 */
[data-slot="user-message-bubble"]::after {
  content: "USER_INPUT";
  position: absolute;
  top: -1px;
  inset-inline-start: 16px;
  padding: 0 5px;
  font-size: 9px;
  line-height: 11px;
  letter-spacing: 0.16em;
  color: var(--lx-accent);
  background: var(--lx-canvas-subtle);
  border: 1px solid color-mix(in srgb, var(--lx-accent) 42%, var(--lx-border-default));
  border-top: 0;
}

[data-slot="user-message-bubble"] [data-testid="user-message-text"] {
  font-variant-ligatures: none;
  letter-spacing: 0.01em;
}
`,
};
