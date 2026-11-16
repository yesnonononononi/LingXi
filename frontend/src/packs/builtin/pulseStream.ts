import type {OfficialPackDefinition} from '../types';
import PulseSendButton from './PulseSendButton.vue';

/**
 * 流式脉冲增强包（组件与动效扩展包）：
 * 替换输入区发送/停止按钮 Slot，并调整流式文字出现节奏与思维链呼吸动效。
 */
export const pulseStreamPack: OfficialPackDefinition = {
  id: 'pulse-stream',
  slots: {
    chatInput: {
      sendButton: PulseSendButton,
    },
  },
  cssText: `
.codex-text-arrival {
  animation-duration: 620ms;
  animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
}

.stream-thinking-content.is-running {
  animation-duration: 0.32s;
}
`,
};
