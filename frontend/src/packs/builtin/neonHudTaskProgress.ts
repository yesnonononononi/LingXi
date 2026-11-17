import type {OfficialPackDefinition} from '../types';
import NeonHudBackgroundPanel from './NeonHudBackgroundPanel.vue';
import NeonHudChecklistPanel from './NeonHudChecklistPanel.vue';
import NeonHudPendingQueuePanel from './NeonHudPendingQueuePanel.vue';

export const neonHudTaskProgressPack: OfficialPackDefinition = {
  id: 'neon-hud-task-progress',
  slots: {
    taskProgress: {
      backgroundPanel: NeonHudBackgroundPanel,
      checklistPanel: NeonHudChecklistPanel,
      pendingQueuePanel: NeonHudPendingQueuePanel,
    },
  },
};
