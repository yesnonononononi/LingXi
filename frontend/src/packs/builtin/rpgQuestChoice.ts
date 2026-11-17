import type {OfficialPackDefinition} from '../types';
import RpgQuestChoiceGroup from './RpgQuestChoiceGroup.vue';

export const rpgQuestChoicePack: OfficialPackDefinition = {
  id: 'rpg-quest-choice',
  slots: {
    interactionCard: {
      choiceGroup: RpgQuestChoiceGroup,
    },
  },
};
