import type {OfficialPackDefinition} from '../types';
import AmberCraftChecklistPanel from './AmberCraftChecklistPanel.vue';

export const amberCraftChecklistPack: OfficialPackDefinition = {
  id: 'amber-craft-checklist',
  slots: { taskProgress: { checklistPanel: AmberCraftChecklistPanel } },
};
