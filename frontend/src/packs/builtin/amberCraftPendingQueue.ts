import type {OfficialPackDefinition} from '../types';
import AmberCraftPendingQueuePanel from './AmberCraftPendingQueuePanel.vue';

export const amberCraftPendingQueuePack: OfficialPackDefinition = {
  id: 'amber-craft-pending-queue',
  slots: { taskProgress: { pendingQueuePanel: AmberCraftPendingQueuePanel } },
};
