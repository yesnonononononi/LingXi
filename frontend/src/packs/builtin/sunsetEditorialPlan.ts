import type {OfficialPackDefinition} from '../types';
import SunsetEditorialPlanCard from './SunsetEditorialPlanCard.vue';

export const sunsetEditorialPlanPack: OfficialPackDefinition = {
  id: 'sunset-editorial-plan',
  slots: {
    interactionCard: {
      planCard: SunsetEditorialPlanCard,
    },
  },
};
