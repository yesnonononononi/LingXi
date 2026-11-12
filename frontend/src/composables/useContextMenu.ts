/**
 * 右键菜单的全局状态与落点探测。
 *
 * <p>模块级单例：一屏只有一个右键菜单，任何组件（消息正文、输入框、预览面板）
 * 都不需要各自挂一套。视觉与交互在 {@link ../components/common/ContextMenu.vue}。</p>
 *
 * <p>落点探测只在事件发生那一刻做一次：菜单项算好就冻结，避免用户先右键再改选区
 * 出现「菜单说能复制、点了没东西」的错位。</p>
 */
import {reactive} from 'vue';
import type {ContextMenuItem, ContextMenuContext, TextEditCommand} from '../utils/contextMenu';
import {isMenuEnabled, resolveTextMenuItems} from '../utils/contextMenu';
import {runTextEditCommand} from '../utils/platform';

/** 右键菜单的可见状态。 */
export interface ContextMenuState {
  open: boolean;
  /** 右键落点（屏幕坐标，未经夹取） */
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** 文本可编辑元素的候选选择器。 */
const EDITABLE_SELECTOR = 'textarea, input, [contenteditable]';

/** 这些 input 类型没有文本可编辑语义，右键不该给剪切/粘贴。 */
const NON_TEXT_INPUT_TYPES: readonly string[] = [
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
];

/** 单例状态：整屏共用一份。 */
const state = reactive<ContextMenuState>({open: false, x: 0, y: 0, items: []});

/**
 * 判断一个 input 是否承载文本编辑。
 *
 * @param element 命中的 input
 * @returns 文本类（含 number/date 等可选中文本的类型）时为 true
 */
const isTextInput = (element: HTMLInputElement): boolean =>
  !NON_TEXT_INPUT_TYPES.includes((element.type || 'text').toLowerCase());

/**
 * 读取 input / textarea 内部选区是否非空。
 *
 * <p>不能用 `window.getSelection()` 判：输入框的选区不属于文档选区，读出来永远是空串，
 * 会让「选中一段文字后右键 → 复制是灰的」。</p>
 *
 * @param element 可编辑元素
 * @returns 存在非空选区时为 true
 */
const hasInputSelection = (element: HTMLInputElement | HTMLTextAreaElement): boolean => {
  const start = element.selectionStart;
  const end = element.selectionEnd;
  return start !== null && end !== null && start !== end;
};

/**
 * 探测右键落点的编辑能力与选区状态。
 *
 * @param target 事件目标节点
 * @returns 供 {@link resolveTextMenuItems} 使用的上下文
 */
const probeContext = (target: EventTarget | null): ContextMenuContext => {
  const element = target instanceof Element ? target.closest(EDITABLE_SELECTOR) : null;
  const editable = element instanceof HTMLElement
    && !(element instanceof HTMLInputElement && !isTextInput(element));

  const documentSelection = typeof window.getSelection === 'function'
    ? (window.getSelection()?.toString() ?? '')
    : '';
  if (!editable) {
    return {editable: false, readOnly: true, hasSelection: documentSelection.length > 0};
  }

  const typed = element as HTMLInputElement | HTMLTextAreaElement;
  const readOnly = typed.readOnly === true || typed.disabled === true;
  const hasSelection = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? hasInputSelection(typed)
    : documentSelection.length > 0;
  return {editable: true, readOnly, hasSelection};
};

/**
 * 尝试在落点处打开菜单。
 *
 * @param event 触发菜单的鼠标事件
 * @returns 真的弹出时为 true（调用方据此 preventDefault）；落点无任何可用命令时为 false
 */
const openTextMenu = (event: MouseEvent): boolean => {
  const items = resolveTextMenuItems(probeContext(event.target));
  if (!isMenuEnabled(items)) {
    return false;
  }
  state.items = items;
  state.x = event.clientX;
  state.y = event.clientY;
  state.open = true;
  return true;
};

/** 关闭菜单并清空上一轮的项，避免下次打开到测量完成之间闪一帧旧菜单。 */
const closeTextMenu = (): void => {
  state.open = false;
  state.items = [];
};

/**
 * 执行一条命令并收起菜单。
 *
 * <p>先收菜单再执行：粘贴要求焦点仍在原来的输入框里，菜单不抢焦点（见组件里的
 * `pointerdown.prevent`），顺序反了会让主进程的 `paste` 落到菜单上。</p>
 *
 * @param command 要执行的命令
 */
const runTextCommand = (command: TextEditCommand): void => {
  closeTextMenu();
  void runTextEditCommand(command);
};

/**
 * 右键菜单组合式函数。
 *
 * @returns { state, openTextMenu, closeTextMenu, runTextCommand }。
 */
export const useContextMenu = () => {
  return {state, openTextMenu, closeTextMenu, runTextCommand};
};
