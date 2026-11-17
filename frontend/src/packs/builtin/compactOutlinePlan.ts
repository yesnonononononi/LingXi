import type {OfficialPackDefinition} from '../types';
import CompactOutlinePlanCard from './CompactOutlinePlanCard.vue';

export const compactOutlinePlanPack: OfficialPackDefinition = {
  id: 'compact-outline-plan',
  slots: {
    interactionCard: {
      planCard: CompactOutlinePlanCard,
    },
  },
};
