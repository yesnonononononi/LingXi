import type {OfficialPackDefinition} from '../types';
import AuditRailApprovalCard from './AuditRailApprovalCard.vue';

export const auditRailApprovalPack: OfficialPackDefinition = {
  id: 'audit-rail-approval',
  slots: {
    interactionCard: {
      approvalCard: AuditRailApprovalCard,
    },
  },
};
