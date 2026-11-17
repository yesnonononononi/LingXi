import type {OfficialPackDefinition} from '../types';
import CompactTerminalApprovalCard from './CompactTerminalApprovalCard.vue';

export const compactTerminalApprovalPack: OfficialPackDefinition = {
  id: 'compact-terminal-approval',
  slots: {
    interactionCard: {
      approvalCard: CompactTerminalApprovalCard,
    },
  },
};
