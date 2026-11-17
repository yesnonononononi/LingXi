import type {OfficialPackDefinition} from '../types';
import NeonHudBackgroundPanel from './NeonHudBackgroundPanel.vue';

export const neonHudBackgroundTaskPack: OfficialPackDefinition = {
  id: 'neon-hud-background-task',
  slots: { taskProgress: { backgroundPanel: NeonHudBackgroundPanel } },
};
