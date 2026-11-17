import type {OfficialPackDefinition} from '../types';
import NeonHudChecklistPanel from './NeonHudChecklistPanel.vue';

export const neonHudChecklistPack: OfficialPackDefinition = {
  id: 'neon-hud-checklist',
  slots: { taskProgress: { checklistPanel: NeonHudChecklistPanel } },
};
