import type {OfficialPackDefinition} from '../types';
import SunsetGlowBackground from './SunsetGlowBackground.vue';

/** 暮光余晖（主页背景包）：暖金与琥珀色对角氛围光晕。 */
export const sunsetGlowPack: OfficialPackDefinition = {
  id: 'sunset-glow',
  slots: {
    background: {
      surface: SunsetGlowBackground,
    },
  },
};
