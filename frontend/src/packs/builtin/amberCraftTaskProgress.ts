import type {OfficialPackDefinition} from '../types';
import AmberCraftBackgroundPanel from './AmberCraftBackgroundPanel.vue';
import AmberCraftChecklistPanel from './AmberCraftChecklistPanel.vue';

export const amberCraftTaskProgressPack: OfficialPackDefinition = {
  id: 'amber-craft-task-progress',
  slots: {
    taskProgress: {
      backgroundPanel: AmberCraftBackgroundPanel,
      checklistPanel: AmberCraftChecklistPanel,
    },
  },
};
