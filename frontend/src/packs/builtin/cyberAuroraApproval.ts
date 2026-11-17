import type {OfficialPackDefinition} from '../types';
import CyberAuroraApprovalCard from './CyberAuroraApprovalCard.vue';

export const cyberAuroraApprovalPack: OfficialPackDefinition = {
  id: 'cyber-aurora-approval',
  slots: {
    interactionCard: {
      approvalCard: CyberAuroraApprovalCard,
    },
  },
};
