/**
 * 右键菜单的纯规则层：命令可用性判定 + 浮层坐标夹取。
 *
 * <p>这里刻意不碰 DOM：落点是否可编辑、有没有选区，由 {@link ../composables/useContextMenu}
 * 探测后当参数喂进来，规则本身在 node 里就能测。</p>
 *
 * <p>同一个浮层承载两组命令：文本编辑（剪切/复制/粘贴/全选）与图片（复制图片/保存图片）。
 * 分组口径见 {@link isTextEditCommand} —— 组件不自己判断命令属于哪一组。</p>
 */

/** 右键菜单能派发的文本命令（与主进程 `edit:command` 的白名单一一对应）。 */
export type TextEditCommand = 'cut' | 'copy' | 'paste' | 'selectAll';

/** 图片预览上的命令：复制到系统剪贴板、另存到用户选定的位置。 */
export type ImageMenuCommand = 'copyImage' | 'saveImage';

/** 同一个浮层承载的全部命令。 */
export type ContextMenuCommand = TextEditCommand | ImageMenuCommand;

/**
 * 一个菜单项：命令 id + 是否禁用。文案由组件按 `contextMenu.<command>` 取 i18n。
 *
 * <p>命令类型是泛型参数：文本菜单与图片菜单各自钉死自己的命令集合，拿错集合在编译期就红，
 * 而 {@link ContextMenuState} 仍然只需要 `ContextMenuItem[]` 一种容器类型。</p>
 */
export interface ContextMenuItem<C extends ContextMenuCommand = ContextMenuCommand> {
  readonly command: C;
  readonly disabled: boolean;
}

/**
 * 图片预览大图上的落点属性（只有 `ImageLightbox` 的大图带它）。
 *
 * <p>右键菜单是全站唯一的浮层，它靠这组属性认出「右键落在可操作的图片上」并把命令换成图片两项；
 * 属性名写在这里而不是各组件里，免得渲染方与探测方各记一份字面量。</p>
 */
export const IMAGE_MENU_TARGET_ATTR = 'data-lx-image-menu';
/** 图片源地址（data: / blob: / http(s)）。 */
export const IMAGE_MENU_SRC_ATTR = 'data-lx-image-src';
/** 可读名称，作为保存对话框的默认文件名。 */
export const IMAGE_MENU_NAME_ATTR = 'data-lx-image-name';

/**
 * 命令是否属于文本编辑那一组。
 *
 * <p>判定放这里而不是在组件里 `if`：组件只管把命令交给对应的实现，分组口径应当跟命令定义
 * 待在同一处，否则新增图片命令时容易漏改组件里的链式判断。</p>
 *
 * @param command 菜单命令
 * @returns 属于剪切/复制/粘贴/全选时为 true
 */
export function isTextEditCommand(command: ContextMenuCommand): command is TextEditCommand {
  return command === 'cut' || command === 'copy' || command === 'paste' || command === 'selectAll';
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

/** 图片菜单项顺序固定（复制 → 另存为）。 */
const IMAGE_MENU_ORDER: readonly ImageMenuCommand[] = ['copyImage', 'saveImage'];

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
export function resolveTextMenuItems(context: ContextMenuContext): Array<ContextMenuItem<TextEditCommand>> {
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
 * 图片预览的右键项：复制 / 另存为，两项恒可用。
 *
 * <p>没做「图还没加载完就禁用」：落点存在就说明大图已经在 DOM 里，真正的失败（跨域取不到字节、
 * 剪贴板被占用）只有执行时才知道，预先灰掉只会变成「明明有图却点不了」。</p>
 *
 * @returns 恒为两项、顺序固定的菜单项
 */
export function resolveImageMenuItems(): Array<ContextMenuItem<ImageMenuCommand>> {
  return IMAGE_MENU_ORDER.map(command => ({command, disabled: false}));
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
