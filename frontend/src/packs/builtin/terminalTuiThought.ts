import type {OfficialPackDefinition} from '../types';
import TerminalTuiThoughtStep from './TerminalTuiThoughtStep.vue';

/** 终端思维缓冲（内置 Slot 极限）：将思考步骤重构为 `[THINK]` 等宽缓冲区与行数遥测条。 */
export const terminalTuiThoughtPack: OfficialPackDefinition = {
  id: 'terminal-tui-thought',
  slots: {
    chatMessage: {
      processThought: TerminalTuiThoughtStep,
    },
  },
};
