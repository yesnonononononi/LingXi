import type {OfficialPackDefinition} from '../types';
import AmberGuardApprovalCard from './AmberGuardApprovalCard.vue';

export const amberGuardApprovalPack: OfficialPackDefinition = {
  id: 'amber-guard-approval',
  slots: {
    interactionCard: {
      approvalCard: AmberGuardApprovalCard,
    },
  },
};
