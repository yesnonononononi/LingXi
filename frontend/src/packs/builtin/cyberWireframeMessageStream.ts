import type {OfficialPackDefinition} from '../types';

/**
 * 遥测线框正文（纯 CSS 极限）：零 JS，为整条消息行加左侧导轨、顶部 `AGENT_OUTPUT`
 * 角标与等宽正文；代码块与行内代码转成锐角线框，和圆角气泡做出明显区隔。
 */
export const cyberWireframeMessageStreamPack: OfficialPackDefinition = {
  id: 'cyber-wireframe-message-stream',
  cssText: `
[data-slot="message-item"] {
  position: relative;
  padding-inline-start: 14px !important;
}

/* 整行导轨：一条通到底的 1px 竖线，比给每段加边框更安静 */
[data-slot="message-item"]::before {
  content: "";
  position: absolute;
  inset-block: 6px;
  inset-inline-start: 4px;
  width: 1px;
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--lx-accent) 55%, transparent) 12%,
    color-mix(in srgb, var(--lx-accent) 55%, transparent) 88%,
    transparent
  );
}

[data-slot="assistant-body"] {
  position: relative;
}

/* 角标贴在正文顶端，像示波器上的通道标签 */
[data-slot="assistant-body"]::before {
  content: "AGENT_OUTPUT";
  display: block;
  margin-bottom: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: color-mix(in srgb, var(--lx-accent) 75%, var(--lx-text-faint));
}

[data-slot="assistant-body"] .markdown-body {
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.72;
}

/* 代码块：直角 + 顶部细线，去掉圆角带来的卡片感 */
[data-slot="assistant-body"] pre {
  border-radius: 2px !important;
  border: 1px solid var(--lx-border-subtle) !important;
  border-top: 2px solid color-mix(in srgb, var(--lx-accent) 50%, transparent) !important;
}

[data-slot="assistant-body"] :not(pre) > code {
  border-radius: 2px !important;
  border: 1px solid var(--lx-border-subtle);
  padding: 0 3px;
}
`,
};
