/**
 * 右键菜单的纯规则层：命令可用性判定 + 浮层坐标夹取。
 *
 * <p>这里刻意不碰 DOM：落点是否可编辑、有没有选区，由 {@link ../composables/useContextMenu}
 * 探测后当参数喂进来，规则本身在 node 里就能测。</p>
 */

/** 右键菜单能派发的文本命令（与主进程 `edit:command` 的白名单一一对应）。 */
export type TextEditCommand = 'cut' | 'copy' | 'paste' | 'selectAll';

/** 一个菜单项：命令 id + 是否禁用。文案由组件按 `contextMenu.<command>` 取 i18n。 */
export interface ContextMenuItem {
  readonly command: TextEditCommand;
  readonly disabled: boolean;
}

/** 右键落点上下文。 */
export interface ContextMenuContext {
  /** 落点是否落在文本可编辑元素内（文本类 input / textarea / contenteditable） */
  readonly editable: boolean;
  /** 可编辑元素是否只读或禁用；非可编辑落点视为只读 */
  readonly readOnly: boolean;
  /** 当前是否存在非空选区 */
  readonly hasSelection: boolean;
}

/** 菜单项顺序固定（剪切 → 复制 → 粘贴 → 全选），禁用项留在原位不塌陷，和原生菜单一致。 */
const MENU_ORDER: readonly TextEditCommand[] = ['cut', 'copy', 'paste', 'selectAll'];

/**
 * 按落点上下文算出四个菜单项的禁用态。
 *
 * <p>规则：剪切要求「可写 + 有选区」；复制只要求有选区（正文选中也能复制）；
 * 粘贴要求可写；全选只要求落在可编辑元素上（只读输入框也允许选中，和系统原生菜单一致）。
 * 禁用项**不删**，否则菜单高度会随右键位置忽高忽低。</p>
 *
 * @param context 落点上下文
 * @returns 恒为四项、顺序固定的菜单项
 */
export function resolveTextMenuItems(context: ContextMenuContext): ContextMenuItem[] {
  const writable = context.editable && !context.readOnly;
  const enabled: Record<TextEditCommand, boolean> = {
    cut: writable && context.hasSelection,
    copy: context.hasSelection,
    paste: writable,
    selectAll: context.editable,
  };
  return MENU_ORDER.map(command => ({command, disabled: !enabled[command]}));
}

/**
 * 菜单是否有任何可用项。
 *
 * <p>没有任何可用项时不弹菜单 —— 比如右键点在空白处，弹出一个四条全灰的菜单等于噪音。
 *
 * @param items 菜单项
 * @returns 至少一项可用时为 true
 */
export function isMenuEnabled(items: readonly ContextMenuItem[]): boolean {
  return items.some(item => !item.disabled);
}

/** 浮层尺寸。 */
export interface MenuSize {
  readonly width: number;
  readonly height: number;
}

/** 视口尺寸。 */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** 屏幕坐标点。 */
export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 把菜单左上角夹进视口：靠近右/下边缘时向左上翻转，绝不超出可视区。
 *
 * @param point 右键落点（屏幕坐标）
 * @param size 菜单实测尺寸
 * @param viewport 视口尺寸
 * @param margin 距视口边缘的留白
 * @returns 调整后的左上角坐标
 */
export function clampMenuPosition(
  point: MenuPoint,
  size: MenuSize,
  viewport: ViewportSize,
  margin = 8
): MenuPoint {
  return {
    x: Math.max(margin, Math.min(point.x, viewport.width - size.width - margin)),
    y: Math.max(margin, Math.min(point.y, viewport.height - size.height - margin)),
  };
}
