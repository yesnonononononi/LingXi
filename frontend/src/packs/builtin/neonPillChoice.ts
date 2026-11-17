import type {OfficialPackDefinition} from '../types';
import NeonPillChoiceGroup from './NeonPillChoiceGroup.vue';

export const neonPillChoicePack: OfficialPackDefinition = {
  id: 'neon-pill-choice',
  slots: {
    interactionCard: {
      choiceGroup: NeonPillChoiceGroup,
    },
  },
};
