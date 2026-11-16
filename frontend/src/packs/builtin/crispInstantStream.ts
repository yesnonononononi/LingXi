import type {OfficialPackDefinition} from '../types';

/** 极速零延迟套件（组件与动效包）：大幅压缩流式文本渐显与状态动画时长，追求极速响应感。 */
export const crispInstantStreamPack: OfficialPackDefinition = {
  id: 'crisp-instant-stream',
  cssText: `
.codex-text-arrival {
  animation-duration: 90ms !important;
}

.animate-blur-in {
  animation-duration: 80ms !important;
}

.stream-thinking-content.is-running {
  animation-duration: 90ms !important;
}
`,
};
