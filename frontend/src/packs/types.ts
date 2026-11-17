import type {ChatBackgroundSlots} from '../types/backgroundSlots';
import type {ChatInputSlotOverrides} from '../types/chatInputSlots';
import type {ChatMessageSlotOverrides} from '../types/chatMessageSlots';
import type {InteractionCardSlotOverrides} from '../types/interactionCardSlots';
import type {SidebarSlotOverrides} from '../types/sidebarSlots';

/** 扩展包分类：不同分类可同时叠加激活，同分类内互斥单选。 */
export type OfficialPackCategory = 'theme' | 'font' | 'background' | 'sidebar' | 'input' | 'component' | 'approvalCard' | 'planCard';

/** 扩展包分类叠加优先级（靠后者在同槽位冲突时覆盖前者）。 */
export const PACK_CATEGORY_ORDER: readonly OfficialPackCategory[] = Object.freeze([
  'theme',
  'font',
  'background',
  'sidebar',
  'input',
  'component',
  'approvalCard',
  'planCard',
]);

/** 官方扩展包预览色板：用于主题/背景类卡片缩略展示。 */
export interface OfficialPackPreview {
  readonly canvas: string;
  readonly surface: string;
  readonly accent: string;
  readonly text: string;
}

/** 扩展包元信息（未加载包体前即可用于分类列表展示）。 */
export interface OfficialPackMeta {
  readonly id: string;
  readonly category: OfficialPackCategory;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** 直观展示该包覆盖的能力点，如 ['配色', '流式节奏']。 */
  readonly capabilities: readonly string[];
  readonly preview?: OfficialPackPreview;
  /** 字体包专属预览文本与 CSS font-family 预览值。 */
  readonly fontPreview?: {
    readonly sample: string;
    readonly family: string;
  };
}

/** 扩展包声明的自定义字体（通过 @font-face 挂载，卸载时随 style 标签一并移除）。 */
export interface OfficialPackFont {
  readonly family: string;
  readonly src: string;
  readonly weight?: string;
  readonly style?: string;
  readonly target: 'sans' | 'code';
}

/** 扩展包可覆盖的五组宿主 UI 槽位。 */
export interface OfficialPackSlots {
  readonly background?: ChatBackgroundSlots;
  readonly chatInput?: ChatInputSlotOverrides;
  readonly chatMessage?: ChatMessageSlotOverrides;
  readonly interactionCard?: InteractionCardSlotOverrides;
  readonly sidebar?: SidebarSlotOverrides;
}

/** 扩展包按需加载后的完整定义。 */
export interface OfficialPackDefinition {
  readonly id: string;
  /** 覆盖 CSS 变量、输入框/侧边栏/流式渲染样式的纯 CSS 文本。 */
  readonly cssText?: string;
  readonly fonts?: readonly OfficialPackFont[];
  readonly slots?: OfficialPackSlots;
}

/** 注册表条目：元信息与懒加载函数分离，未启用时不打包进首屏 chunk。 */
export interface OfficialPackEntry {
  readonly meta: OfficialPackMeta;
  readonly load: () => Promise<OfficialPackDefinition>;
}
