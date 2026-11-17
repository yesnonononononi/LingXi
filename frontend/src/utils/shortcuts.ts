/**
 * 快捷键的单一真源（纯函数，无 Vue / 无副作用）。
 *
 * <p>绑定文本统一写成「修饰键 + 键」的规范形式：修饰键只认 `Mod`（Windows/Linux = Ctrl，
 * macOS = ⌘）、`Alt`、`Shift`，顺序固定。存进后端的、界面上比较的、事件里匹配的，
 * 全是这一份规范文本 —— 三处各写一套拼装，冲突检测就会漏（`Ctrl+Shift+K` 与
 * `shift+ctrl+k` 会被当成两个不同的键）。</p>
 *
 * <p>为什么以 `event.key` 为准：中文输入法激活时 `key` 会漂移，但 `code` 又与键盘布局
 * 对不上（用户看到的是字，不是物理位置）。这里以 `key` 为准，并在匹配时做同样的归一化。</p>
 */

/** 快捷键动作清单：新增动作只需在这里加一项，再补默认值与展示名。 */
export const SHORTCUT_ACTIONS = [
  'toggleSidebar',
  'togglePreview',
  'toggleSettings',
  'newSession',
  'sendMessage',
  'insertNewline',
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/**
 * 生效范围：`global` 由窗口级监听统一分发；`input` 只属于输入框自己的 keydown。
 *
 * <p>输入框动作绝不能进全局分发 —— 否则在输入框里按 Enter 会先被窗口监听吃掉一次，
 * 用户看到的要么是发两遍，要么是压根不换行。</p>
 */
export type ShortcutScope = 'global' | 'input';

export type ShortcutMap = Record<ShortcutAction, string>;

/** 需要窗口级监听分发的动作：与 {@link SHORTCUT_SCOPES} 中的 `global` 一一对应。 */
export type GlobalShortcutAction = 'toggleSidebar' | 'togglePreview' | 'toggleSettings' | 'newSession';

export const SHORTCUT_SCOPES: Record<ShortcutAction, ShortcutScope> = {
  toggleSidebar: 'global',
  togglePreview: 'global',
  toggleSettings: 'global',
  newSession: 'global',
  sendMessage: 'input',
  insertNewline: 'input',
};

/** 全局分发只走这几个动作；新增动作时若漏了这里，它会被静默当成输入框专用。 */
export const GLOBAL_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_SCOPES) as ShortcutAction[])
  .filter(action => SHORTCUT_SCOPES[action] === 'global') as GlobalShortcutAction[];

/** 默认绑定：与历史硬编码行为保持一致（预览面板原本就是 Ctrl+\）。 */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  toggleSidebar: 'Mod+B',
  togglePreview: 'Mod+\\',
  toggleSettings: 'Mod+,',
  newSession: 'Mod+N',
  sendMessage: 'Enter',
  insertNewline: 'Shift+Enter',
};

const MODIFIER_TOKENS = new Set(['mod', 'ctrl', 'control', 'cmd', 'command', 'meta', '⌘', '⌃']);
const ALT_TOKENS = new Set(['alt', 'option', '⌥']);
const SHIFT_TOKENS = new Set(['shift', '⇧']);

/** 具名键：单个字符以外的键必须出现在这里，否则判为不可解析（防止把拼错的键名存进去）。 */
const NAMED_KEYS = [
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
] as const;

const NAMED_KEY_BY_LOWER = new Map<string, string>(NAMED_KEYS.map(name => [name.toLowerCase(), name]));
const EVENT_MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Dead', 'Unidentified']);
/**
 * 键名归一化失败时按物理位置兜底。
 *
 * <p>中文输入法激活时 `event.key` 会变成 '、' 之类的字符，按 `key` 比就永远匹配不上；
 * 这些标点键在任意布局下位置固定，用 `code` 兜得住。字母键**不做**兜底 ——
 * 输入法处理中的 `key` 是 'Process'，用 code 兜会让 Ctrl+B 在打字时误触发。</p>
 */
const KEY_BY_CODE = new Map<string, string>([
  ['Backslash', '\\'], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['Semicolon', ';'],
  ['Quote', "'"], ['BracketLeft', '['], ['BracketRight', ']'], ['Backquote', '`'],
  ['Minus', '-'], ['Equal', '='], ['Space', 'Space'],
]);

export interface ShortcutBinding {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** 只取判定所需的字段，KeyboardEvent 与测试里的假事件都能直接传入。 */
export interface ShortcutKeyEvent {
  key: string;
  /** 物理键位，仅在 key 归一化失败时用于标点键兜底。 */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** 单个绑定的非法原因，由界面翻译成中文文案。 */
export type ShortcutProblem = 'empty' | 'unparsable' | 'needs-modifier';

export interface ShortcutConflict {
  /** 冲突的规范文本（展示用）。 */
  text: string;
  actions: ShortcutAction[];
}

/** 归一化单个键名：字母统一大写，空格转 Space，具名键按规范名返回。 */
function normalizeKey(raw: string): string | null {
  if (!raw) return null;
  if (raw === ' ') return 'Space';
  if (raw.length === 1) return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw;
  return NAMED_KEY_BY_LOWER.get(raw.toLowerCase()) ?? null;
}

/** 解析规范文本；无法解析返回 null（区别于「空」）。 */
export function parseShortcut(text: string | null | undefined): ShortcutBinding | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const tokens = trimmed.split('+');
  const keyToken = tokens.pop() ?? '';
  let mod = false;
  let alt = false;
  let shift = false;
  for (const token of tokens) {
    const word = token.trim().toLowerCase();
    if (MODIFIER_TOKENS.has(word)) mod = true;
    else if (ALT_TOKENS.has(word)) alt = true;
    else if (SHIFT_TOKENS.has(word)) shift = true;
    // 未知修饰键直接判不可解析：静默忽略会把「Ctrl+Alt+K」存成「Alt+K」这种假绑定
    else return null;
  }
  const key = normalizeKey(keyToken.trim());
  if (!key) return null;
  return { mod, alt, shift, key };
}

/** 组装规范文本（修饰键顺序固定：Mod → Alt → Shift → 键）。 */
export function formatBindingText(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push('Mod');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key);
  return parts.join('+');
}

/** 把任意写法收敛成规范文本；不可解析返回 null。 */
export function canonicalShortcutText(text: string | null | undefined): string | null {
  const binding = parseShortcut(text);
  return binding ? formatBindingText(binding) : null;
}

/**
 * 从事件里取规范键名。
 *
 * <p>字母、数字与具名键以 `event.key` 为准（它们不会被输入法改写）；标点键优先按 `code`
 * 还原 —— 中文输入法激活时反斜杠会报成 '、'，只比 `key` 就永远匹配不上。
 * 字母键刻意**不**走 `code` 兜底：输入法处理中 `key` 是 'Process'，
 * 用 `code` 兜会让 Ctrl+B 在打字时误触发。</p>
 */
function resolveEventKey(event: ShortcutKeyEvent): string | null {
  const direct = normalizeKey(event.key);
  if (direct && (direct.length > 1 || /[A-Za-z0-9]/.test(direct))) return direct;
  const fallback = event.code ? KEY_BY_CODE.get(event.code) ?? null : null;
  return fallback ?? direct;
}

/** 从按键事件反推规范文本：只按下修饰键时返回 null（那不是一个组合键）。 */
export function shortcutFromEvent(event: ShortcutKeyEvent): string | null {
  if (!event.key || EVENT_MODIFIER_KEYS.has(event.key)) return null;
  const key = resolveEventKey(event);
  if (!key) return null;
  return formatBindingText({
    mod: Boolean(event.ctrlKey || event.metaKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    key,
  });
}

/**
 * 校验一个绑定是否可用。
 *
 * <p>除输入框里的 Enter 之外，一律要求带 Mod 或 Alt：Shift+字母 在输入框里就是「打个大写」，
 * 允许它等于把正常输入当成快捷键。Shift 不算命令修饰键。</p>
 */
export function validateShortcutText(text: string | null | undefined, scope: ShortcutScope): ShortcutProblem | null {
  if (!(text ?? '').trim()) return 'empty';
  const binding = parseShortcut(text);
  if (!binding) return 'unparsable';
  if (binding.mod || binding.alt) return null;
  if (binding.key === 'Enter' && scope === 'input') return null;
  return 'needs-modifier';
}

/** 事件是否命中某个绑定文本。 */
export function matchesShortcut(event: ShortcutKeyEvent, text: string | null | undefined): boolean {
  const binding = parseShortcut(text);
  if (!binding) return false;
  return shortcutFromEvent(event) === formatBindingText(binding);
}

/**
 * 找出绑到同一个组合的多个动作。
 *
 * <p>先归一化再比：`Mod+Shift+K` 与 `shift+mod+k` 是同一个键，不归一的话用户在界面上
 * 两次输入看起来不同、实际互相覆盖，设置页会给出「没问题」的假绿灯。</p>
 */
export function findShortcutConflicts(map: Partial<Record<string, string>> | null | undefined): ShortcutConflict[] {
  const byText = new Map<string, ShortcutAction[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const text = canonicalShortcutText(map?.[action]);
    if (!text) continue;
    const actions = byText.get(text);
    if (actions) actions.push(action);
    else byText.set(text, [action]);
  }
  const conflicts: ShortcutConflict[] = [];
  byText.forEach((actions, text) => {
    if (actions.length > 1) conflicts.push({ text, actions });
  });
  return conflicts;
}

/**
 * 把后端下发的原始映射收敛成一份完整绑定表。
 *
 * <p>缺项、非法项、未知动作一律回落默认值：老档没有这个字段、或键名拼错时，
 * 界面与运行时都必须还能用，而不是「快捷键集体失灵」。</p>
 */
export function normalizeShortcutMap(raw: Partial<Record<string, string>> | null | undefined): ShortcutMap {
  const normalized = { ...DEFAULT_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const text = canonicalShortcutText(raw?.[action]);
    if (text && !validateShortcutText(text, SHORTCUT_SCOPES[action])) {
      normalized[action] = text;
    }
  }
  return normalized;
}

/** 展示文案：macOS 用符号，其它平台用 Ctrl / Alt / Shift 全称。 */
export function formatShortcutLabel(text: string | null | undefined, platform?: string): string {
  const binding = parseShortcut(text);
  if (!binding) return '';
  const isMac = platform === 'darwin';
  const parts: string[] = [];
  if (binding.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(binding.key === 'Space' ? 'Space' : binding.key);
  return parts.join('+');
}
