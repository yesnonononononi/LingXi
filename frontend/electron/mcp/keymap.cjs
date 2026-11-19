/**
 * 按键名归一：DOM / Playwright 词表 → Electron sendInputEvent 的 keyCode 词表。
 *
 *实测结论（2026-11-19，内置浏览器真机探针）：`sendInputEvent` 只认 Electron
 * accelerator 词表。`Escape`/`Tab`/`Backspace`/单字符两套词表同名所以碰巧可用，
 * `ArrowDown` 这类 DOM 名会派发出一个 key 为空、keyCode 为 0 的事件——页面收得到、
 * 但等于没按，且工具返回 ok。所以这里必须显式翻译，未知键名直接报错而不是放行。
 */

const {TOOL_ERROR, toolError} = require('./errors.cjs');

/** DOM 键名 → Electron keyCode。只收录两套词表真的不同的名字。 */
const KEY_ALIASES = Object.freeze({
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  // Electron 的 accelerator 词表里是 Return；实测旧实现一直用这个映射，保持一致
  Enter: 'Return',
  Space: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
});

/** Electron 原生认得的具名键（大小写不敏感比较）。 */
// 不收 Enter：它走 KEY_ALIASES 翻成 Return，收进来会让小写 enter 命中这里而绕过映射
const ELECTRON_NAMED_KEYS = Object.freeze([
  'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Escape',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'Space', 'Capslock', 'Numlock', 'Scrolllock', 'Printscreen',
  'VolumeUp', 'VolumeDown', 'VolumeMute',
  'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
  ...Array.from({length: 24}, (_item, index) => `F${index + 1}`),
]);

/** 修饰键别名 → Electron modifiers 取值。 */
const MODIFIER_ALIASES = Object.freeze({
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  command: 'meta',
  cmd: 'meta',
});

const NAMED_KEY_LOOKUP = new Map(ELECTRON_NAMED_KEYS.map(key => [key.toLowerCase(), key]));

/**
 * 把模型给的键名翻译成 Electron keyCode。
 *
 * @param key 模型传入的键名，如 ArrowDown / Enter / a
 * @returns Electron 认得的 keyCode
 * @throws ToolError 键名为空或不在任何一套词表里
 */
function toInputKeyCode(key) {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw) {
    throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'key 不能为空');
  }
  if (KEY_ALIASES[raw]) return KEY_ALIASES[raw];
  if (raw.length === 1) return raw;
  const named = NAMED_KEY_LOOKUP.get(raw.toLowerCase());
  if (named) return named;
  if (KEY_ALIASES[canonicalize(raw)]) return KEY_ALIASES[canonicalize(raw)];
  throw toolError(
    TOOL_ERROR.UNSUPPORTED_KEY,
    `不支持的按键: ${raw}。方向键写 ArrowUp/ArrowDown/ArrowLeft/ArrowRight，`
      + '其余写 Tab、Enter、Escape、Backspace、Delete、Home、End、F1~F24 或单个字符',
  );
}

/** 把 arrowdown / arrow_down 之类的写法折回 ArrowDown。 */
function canonicalize(raw) {
  const lowered = raw.toLowerCase();
  for (const alias of Object.keys(KEY_ALIASES)) {
    if (alias.toLowerCase() === lowered) return alias;
  }
  return '';
}

/**
 * 归一修饰键列表：别名折成 Electron 取值，未知修饰键直接报错。
 *
 * @param modifiers 模型传入的字符串数组
 * @returns Electron modifiers 数组
 */
function normalizeModifiers(modifiers) {
  if (!Array.isArray(modifiers)) return [];
  const result = [];
  for (const item of modifiers) {
    const raw = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!raw) continue;
    const normalized = MODIFIER_ALIASES[raw];
    if (!normalized) {
      throw toolError(
        TOOL_ERROR.UNSUPPORTED_KEY,
        `不支持的修饰键: ${item}。可用 control / shift / alt / meta`,
      );
    }
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

module.exports = {KEY_ALIASES, MODIFIER_ALIASES, ELECTRON_NAMED_KEYS, toInputKeyCode, normalizeModifiers};
