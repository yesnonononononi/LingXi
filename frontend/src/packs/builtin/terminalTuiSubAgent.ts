import type {OfficialPackDefinition} from '../types';
import TerminalTuiSubAgent from './TerminalTuiSubAgent.vue';

/** 终端进程树子代理（内置 Slot 极限）：将子代理协同条重构为 `[PROC-TREE]` 进程状态面板。 */
export const terminalTuiSubAgentPack: OfficialPackDefinition = {
  id: 'terminal-tui-sub-agent',
  slots: {
    chatMessage: {
      processSubAgent: TerminalTuiSubAgent,
    },
  },
};
