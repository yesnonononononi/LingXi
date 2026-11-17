import type {OfficialPackDefinition} from '../types';
import NeonHudPendingQueuePanel from './NeonHudPendingQueuePanel.vue';

export const neonHudPendingQueuePack: OfficialPackDefinition = {
  id: 'neon-hud-pending-queue',
  slots: { taskProgress: { pendingQueuePanel: NeonHudPendingQueuePanel } },
};
