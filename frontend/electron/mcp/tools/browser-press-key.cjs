/**
 * browser_press_key：在页面里按键。
 *
 *键名必须先过 keymap：`sendInputEvent` 只认 Electron 词表，DOM 的 ArrowDown
 * 会派发出一个 key 为空、keyCode 为 0 的事件——页面收到但等于没按，还不报错。
 */

const {normalizeText} = require('../args.cjs');
const {toInputKeyCode, normalizeModifiers} = require('../keymap.cjs');

module.exports = {
  name: 'browser_press_key',
  method: 'pressKey',
  description: 'Press a keyboard key (with optional modifiers like control, shift, alt, meta) in the built-in browser page.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {type: 'string', description: 'Key name: ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Enter, Escape, Tab, Backspace, Delete, Home, End, PageUp/PageDown, F1-F24, or a single character.'},
      modifiers: {type: 'array', items: {type: 'string'}, description: 'Optional modifier keys (e.g. ["control"], ["shift"]).'},
      ref: {type: 'string', description: 'Optional element ref to focus before pressing the key.'},
      selector: {type: 'string', description: 'Optional CSS selector to focus before pressing the key.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
    required: ['key'],
  },

  async run(host, args) {
    // 先翻译键名：非法键名在这里就失败，不要等到发完事件才发现按了个空键
    const keyCode = toInputKeyCode(args.key);
    const modifiers = normalizeModifiers(args.modifiers);
    const rawKey = normalizeText(args.key);
    const rawRef = normalizeText(args.ref);
    const rawSelector = normalizeText(args.selector);

    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const navWatch = keyCode === 'Return' || keyCode === 'Enter' ? host.beginNavigationWatch(tab) : null;

    const result = await host.withAgentControl(tab, async () => {
      if (rawRef || rawSelector) {
        const focused = await host.runScript(tab, 'focus', {rawRef, rawSelector});
        if (!focused || !focused.ok) {
          throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, (focused && focused.error) || '聚焦元素失败');
        }
      }
      if (host.canSendInputEvent(tab)) {
        host.focusContents(tab);
        host.sendKey(tab, keyCode, modifiers);
        return {ok: true, key: rawKey, inputKeyCode: keyCode, modifiers, tabId: tab.id, url: tab.url, title: tab.title};
      }
      const fallback = await host.runScript(tab, 'press-key-fallback', {key: rawKey, modifiers});
      return {...fallback, key: rawKey, inputKeyCode: keyCode, modifiers, tabId: tab.id};
    });

    const navigation = navWatch ? await navWatch.settle() : null;
    return {
      ...result,
      url: (navigation && navigation.url) || result.url || tab.url,
      title: (navigation && navigation.title) || result.title || tab.title,
      navigated: Boolean(navigation && navigation.navigated),
    };
  },
};
