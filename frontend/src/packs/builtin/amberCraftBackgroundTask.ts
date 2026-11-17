import type {OfficialPackDefinition} from '../types';
import AmberCraftBackgroundPanel from './AmberCraftBackgroundPanel.vue';

export const amberCraftBackgroundTaskPack: OfficialPackDefinition = {
  id: 'amber-craft-background-task',
  slots: { taskProgress: { backgroundPanel: AmberCraftBackgroundPanel } },
};
