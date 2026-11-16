import type {OfficialPackDefinition} from '../types';
import BlueprintGridBackground from './BlueprintGridBackground.vue';

/** 工程点阵网格（主页背景包）：极细坐标点阵与边缘渐隐遮罩。 */
export const blueprintGridPack: OfficialPackDefinition = {
  id: 'blueprint-grid',
  slots: {
    background: {
      surface: BlueprintGridBackground,
    },
  },
};
