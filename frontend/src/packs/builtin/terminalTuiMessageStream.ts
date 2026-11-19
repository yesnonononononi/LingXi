import type {OfficialPackDefinition} from '../types';
import TerminalTuiMessageBody from './TerminalTuiMessageBody.vue';
import TerminalTuiActionsBar from './TerminalTuiActionsBar.vue';

/**
 * 终端输出流（内置 Slot 极限）：正文替换为 `agent:~/out` 进程输出，操作栏替换为一行遥测。
 *
 * 等宽与 gutter 由组件自身的 scoped 样式承担；这里只补一条组件管不到的事：
 * Markdown 里的代码块保持终端配色，不要被主题的圆角卡片样式拉回去。
 */
export const terminalTuiMessageStreamPack: OfficialPackDefinition = {
  id: 'terminal-tui-message-stream',
  slots: {
    chatMessage: {
      body: TerminalTuiMessageBody,
      actions: TerminalTuiActionsBar,
    },
  },
  cssText: `
[data-testid="assistant-body"] .markdown-body pre {
  border-radius: 3px !important;
}
`,
};
