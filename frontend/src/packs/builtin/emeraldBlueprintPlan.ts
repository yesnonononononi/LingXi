import type {OfficialPackDefinition} from '../types';
import EmeraldBlueprintPlanCard from './EmeraldBlueprintPlanCard.vue';

export const emeraldBlueprintPlanPack: OfficialPackDefinition = {
  id: 'emerald-blueprint-plan',
  slots: {
    interactionCard: {
      planCard: EmeraldBlueprintPlanCard,
    },
  },
};
