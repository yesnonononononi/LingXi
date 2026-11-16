import type {OfficialPackDefinition} from '../types';

/** 墨韵缓显套件（组件与动效包）：拉长流式渐显与卡片入场曲线，带来水墨晕染般的阅读节奏。 */
export const softInkStreamPack: OfficialPackDefinition = {
  id: 'soft-ink-stream',
  cssText: `
.codex-text-arrival {
  animation-duration: 780ms !important;
  animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1) !important;
}

.animate-blur-in {
  animation-duration: 380ms !important;
}

.stream-thinking-content.is-running {
  animation-duration: 420ms !important;
}
`,
};
