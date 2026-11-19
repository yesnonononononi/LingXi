import type {OfficialPackDefinition} from '../types';
import TerminalTuiToolCall from './TerminalTuiToolCall.vue';

/** 终端命令执行流（内置 Slot 极限）：将工具调用行重构为 `$ exec` 命令行执行条与 STDOUT 抽屉。 */
export const terminalTuiToolPack: OfficialPackDefinition = {
  id: 'terminal-tui-tool',
  slots: {
    chatMessage: {
      processTool: TerminalTuiToolCall,
    },
  },
};
