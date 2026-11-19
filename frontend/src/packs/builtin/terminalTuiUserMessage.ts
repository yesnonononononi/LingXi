import type {OfficialPackDefinition} from '../types';
import TerminalTuiUserMessage from './TerminalTuiUserMessage.vue';

/**
 * 终端命令行输入（内置 Slot 极限）：用户气泡变成一段 `user@lingxi:~$` 会话。
 *
 * 组件自己画终端窗口；这里让整行铺满对话列——终端窗口不该像气泡那样只占半行。
 */
export const terminalTuiUserMessagePack: OfficialPackDefinition = {
  id: 'terminal-tui-user-message',
  slots: {
    chatMessage: {
      userBody: TerminalTuiUserMessage,
    },
  },
  cssText: `
[data-slot="message-item"] [data-testid="user-message"] {
  width: 100%;
  max-width: var(--container-lx-chat, 48rem);
  align-items: stretch;
}
`,
};
