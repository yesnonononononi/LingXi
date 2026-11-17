import type {OfficialPackDefinition} from '../types';
import EditorialDocPlanCard from './EditorialDocPlanCard.vue';

export const editorialDocPlanPack: OfficialPackDefinition = {
  id: 'editorial-doc-plan',
  slots: {
    interactionCard: {
      planCard: EditorialDocPlanCard,
    },
  },
};
