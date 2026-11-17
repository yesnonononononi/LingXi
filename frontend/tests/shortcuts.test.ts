import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRenderer, defineComponent, nextTick} from 'vue';
import {
  DEFAULT_SHORTCUTS,
  GLOBAL_SHORTCUT_ACTIONS,
  SHORTCUT_ACTIONS,
  SHORTCUT_SCOPES,
  canonicalShortcutText,
  findShortcutConflicts,
  formatShortcutLabel,
  matchesShortcut,
  normalizeShortcutMap,
  shortcutFromEvent,
  validateShortcutText,
} from '../src/utils/shortcuts';
import {applyShortcutBindings, useGlobalShortcuts, useShortcuts} from '../src/composables/useShortcuts';
import type {PersonalizationVO} from '../src/services/personalization';
import {PersonalizationAPI} from '../src/services/personalization';
import {usePersonalizationTab} from '../src/views/settings/tabs/usePersonalizationTab';

/** 造一个按键事件：只给出关心的字段，其余按「没按」处理。 */
function press(init: {key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean}) {
  return {ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init};
}

function stubRenderer() {
  return createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
    patchProp() {}, insert() {}, remove() {},
  });
}

test('默认绑定覆盖全部动作，预览面板仍是历史行为 Ctrl+\\', () => {
  assert.deepEqual(Object.keys(DEFAULT_SHORTCUTS).sort(), [...SHORTCUT_ACTIONS].sort());
  assert.equal(DEFAULT_SHORTCUTS.togglePreview, 'Mod+\\');
  assert.equal(DEFAULT_SHORTCUTS.sendMessage, 'Enter');
  assert.equal(DEFAULT_SHORTCUTS.insertNewline, 'Shift+Enter');
  // 全局分发清单必须与 scope 声明一致：漏一个动作，那个键就静默失效
  assert.deepEqual([...GLOBAL_SHORTCUT_ACTIONS].sort(),
    SHORTCUT_ACTIONS.filter(action => SHORTCUT_SCOPES[action] === 'global').sort());
});

test('后端脏数据与老档缺项一律回落默认值', () => {
  assert.deepEqual(normalizeShortcutMap(null), DEFAULT_SHORTCUTS);
  const dirty = normalizeShortcutMap({toggleSidebar: 'Mod', newSession: '不认识的键', togglePreview: 'ctrl+\\'});
  assert.equal(dirty.toggleSidebar, DEFAULT_SHORTCUTS.toggleSidebar);
  assert.equal(dirty.newSession, DEFAULT_SHORTCUTS.newSession);
  assert.equal(dirty.togglePreview, DEFAULT_SHORTCUTS.togglePreview);
});

test('绑定文本归一化：忽略大小写与修饰键顺序', () => {
  assert.equal(canonicalShortcutText('shift+mod+k'), 'Mod+Shift+K');
  assert.equal(canonicalShortcutText('CMD+,'), 'Mod+,');
  assert.equal(canonicalShortcutText('ctrl+alt+b'), 'Mod+Alt+B');
  assert.equal(canonicalShortcutText('space'), 'Space');
  assert.equal(canonicalShortcutText('Mod+'), null);
  assert.equal(canonicalShortcutText('Hyper+K'), null);
});

test('冲突按归一化文本判定', () => {
  assert.deepEqual(findShortcutConflicts(DEFAULT_SHORTCUTS), []);
  // ctrl+b 与默认的 Mod+B 是同一个键，写法不同不该被当成两回事
  const conflicts = findShortcutConflicts({...DEFAULT_SHORTCUTS, newSession: 'ctrl+b'});
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].text, 'Mod+B');
  assert.deepEqual(conflicts[0].actions, ['toggleSidebar', 'newSession']);
});

test('按键匹配精确到修饰键：Shift+Enter 不能触发 Enter 发送', () => {
  assert.equal(matchesShortcut(press({key: 'Enter'}), 'Enter'), true);
  assert.equal(matchesShortcut(press({key: 'Enter', shiftKey: true}), 'Enter'), false);
  assert.equal(matchesShortcut(press({key: 'Enter', shiftKey: true}), 'Shift+Enter'), true);
  assert.equal(matchesShortcut(press({key: 'b', ctrlKey: true}), 'Mod+B'), true);
  assert.equal(matchesShortcut(press({key: 'B', metaKey: true}), 'Mod+B'), true);
  assert.equal(matchesShortcut(press({key: 'b'}), 'Mod+B'), false);
  assert.equal(matchesShortcut(press({key: 'b', ctrlKey: true, altKey: true}), 'Mod+B'), false);
  assert.equal(matchesShortcut(press({key: 'Control', ctrlKey: true}), 'Mod+Control'), false);
});

test('录制按键：只按修饰键不产生组合键，输入法把标点改写成别的字符时按物理位置兜底', () => {
  assert.equal(shortcutFromEvent(press({key: 'Control', ctrlKey: true})), null);
  assert.equal(shortcutFromEvent(press({key: 'Shift', shiftKey: true})), null);
  assert.equal(shortcutFromEvent(press({key: 'b', ctrlKey: true, shiftKey: true})), 'Mod+Shift+B');
  assert.equal(shortcutFromEvent(press({key: ' '})), 'Space');
  // 中文输入法把反斜杠报成 '、'，靠 code 还原，预览面板的 Ctrl+\ 才不会失灵
  assert.equal(matchesShortcut({key: '、', code: 'Backslash', ctrlKey: true}, 'Mod+\\'), true);
  // 字母键不做 code 兜底：输入法处理中的 'Process' 不能被当成 KeyB
  assert.equal(matchesShortcut({key: 'Process', code: 'KeyB', ctrlKey: true}, 'Mod+B'), false);
});

test('非法绑定被拦：普通键必须带 Mod 或 Alt，输入框里的 Enter 例外', () => {
  assert.equal(validateShortcutText('', 'global'), 'empty');
  assert.equal(validateShortcutText('Hyper+K', 'global'), 'unparsable');
  assert.equal(validateShortcutText('B', 'global'), 'needs-modifier');
  assert.equal(validateShortcutText('Shift+B', 'input'), 'needs-modifier');
  assert.equal(validateShortcutText('Enter', 'global'), 'needs-modifier');
  assert.equal(validateShortcutText('Enter', 'input'), null);
  assert.equal(validateShortcutText('Shift+Enter', 'input'), null);
  assert.equal(validateShortcutText('Mod+Enter', 'input'), null);
});

test('展示文案按平台切换符号', () => {
  assert.equal(formatShortcutLabel('Mod+Shift+B', 'darwin'), '⌘+⇧+B');
  assert.equal(formatShortcutLabel('Mod+Shift+B', 'win32'), 'Ctrl+Shift+B');
  assert.equal(formatShortcutLabel('Mod+\\', 'win32'), 'Ctrl+\\');
  assert.equal(formatShortcutLabel('Enter', 'win32'), 'Enter');
});

/** 在假的 window 上挂载分发器，拿到真实注册的 keydown 监听。 */
function withWindow(run: (listeners: Set<(event: unknown) => void>) => void) {
  const listeners = new Set<(event: unknown) => void>();
  const globalScope = globalThis as unknown as {window?: unknown};
  const previous = globalScope.window;
  globalScope.window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === 'keydown') listeners.add(handler);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === 'keydown') listeners.delete(handler);
    },
  };
  try {
    run(listeners);
  } finally {
    globalScope.window = previous;
  }
}

function mountDispatcher(handlers: Record<string, () => void>) {
  const app = stubRenderer().createApp(defineComponent({
    setup() { useGlobalShortcuts(() => handlers); return () => null; },
  }));
  app.mount({});
  return app;
}

test('窗口级分发：命中即执行并阻断默认行为，输入框动作不参与分发', () => {
  withWindow(listeners => {
    const calls: string[] = [];
    const app = mountDispatcher({
      toggleSidebar: () => calls.push('sidebar'),
      togglePreview: () => calls.push('preview'),
      toggleSettings: () => calls.push('settings'),
      newSession: () => calls.push('newSession'),
      sendMessage: () => calls.push('send'),
      insertNewline: () => calls.push('newline'),
    });
    assert.equal(listeners.size, 1);
    const dispatch = [...listeners][0];
    const prevented: number[] = [];
    const send = (event: Record<string, unknown>) => dispatch({
      repeat: false, isComposing: false, defaultPrevented: false,
      preventDefault: () => prevented.push(1), ...event,
    });

    applyShortcutBindings(null);
    send(press({key: 'b', ctrlKey: true}));
    send(press({key: '\\', ctrlKey: true}));
    send(press({key: ',', ctrlKey: true}));
    send(press({key: 'n', ctrlKey: true}));
    assert.deepEqual(calls, ['sidebar', 'preview', 'settings', 'newSession']);
    assert.deepEqual(prevented, [1, 1, 1, 1]);

    // 输入框动作绝不能被窗口监听吃掉，否则 Enter 会发送两遍／压根不换行
    send(press({key: 'Enter'}));
    send(press({key: 'Enter', shiftKey: true}));
    assert.equal(calls.length, 4);

    // 长按重复、输入法组合中、已被别人处理过的事件一律跳过
    send({...press({key: 'b', ctrlKey: true}), repeat: true});
    send({...press({key: 'b', ctrlKey: true}), isComposing: true});
    send({...press({key: 'b', ctrlKey: true}), defaultPrevented: true});
    assert.equal(calls.length, 4);
    assert.equal(prevented.length, 4);

    // 设置页保存后覆盖绑定，无需重新挂监听
    applyShortcutBindings({...DEFAULT_SHORTCUTS, toggleSidebar: 'Mod+Shift+M'});
    send(press({key: 'b', ctrlKey: true}));
    assert.equal(calls.length, 4);
    send(press({key: 'm', ctrlKey: true, shiftKey: true}));
    assert.equal(calls.at(-1), 'sidebar');

    // 存进脏数据时两个动作撞同一个键：一次按键只允许触发第一个，不跟着连锁触发
    applyShortcutBindings({...DEFAULT_SHORTCUTS, newSession: 'Mod+B'});
    send(press({key: 'b', ctrlKey: true}));
    assert.deepEqual(calls.slice(-1), ['sidebar']);

    app.unmount();
    assert.equal(listeners.size, 0);
    applyShortcutBindings(null);
  });
});

const stubState = (shortcuts: Record<string, string> | null): PersonalizationVO => ({
  id: '1', title: '', commonAgentName: '', replyStyle: 'DEFAULT', customInstruction: '', shortcuts,
});

async function mountTab() {
  let state!: ReturnType<typeof usePersonalizationTab>;
  const app = stubRenderer().createApp(defineComponent({setup() { state = usePersonalizationTab(); return () => null; }}));
  app.mount({});
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
  return {state, app};
}

test('设置页：快捷键冲突拦住保存，保存成功后运行时绑定立即生效', async t => {
  let stored: PersonalizationVO = stubState(null);
  t.mock.method(PersonalizationAPI, 'current', async () => ({code: 1, data: {...stored}}));
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({code: 1, data: [{value: 'DEFAULT', label: '默认'}]}));
  const update = t.mock.method(PersonalizationAPI, 'update', async payload => {
    stored = {...stored, ...payload} as PersonalizationVO;
    return {code: 1};
  });
  const {state, app} = await mountTab();
  t.after(() => app.unmount());
  assert.deepEqual({...state.draft.shortcuts}, DEFAULT_SHORTCUTS);
  assert.equal(state.dirty.value, false);

  // 用 Ctrl 写法表达同一个键（Mod 在 Windows 上就是 Ctrl）→ 判冲突且不允许保存
  state.draft.shortcuts.newSession = 'ctrl+b';
  assert.equal(state.shortcutsBlocked.value, true);
  assert.equal(state.shortcutConflicts.value.length, 1);
  await state.save();
  assert.equal(update.mock.callCount(), 0);
  assert.ok(state.error.value.includes('快捷键冲突'));

  // 改成不冲突的键就放行，并把新绑定写进运行时真源
  state.draft.shortcuts.newSession = 'Mod+Shift+O';
  assert.equal(state.shortcutsBlocked.value, false);
  await state.save();
  assert.equal(update.mock.callCount(), 1);
  assert.equal(update.mock.calls[0]?.arguments[0].shortcuts.newSession, 'Mod+Shift+O');
  assert.equal(state.saved.value, true);
  assert.equal(useShortcuts().bindings.value.newSession, 'Mod+Shift+O');
  applyShortcutBindings(null);
});

test('输入框的发送判定走配置绑定，不再硬编码 Enter', () => {
  const source = readFileSync(new URL('../src/components/chat/ChatInputArea.vue', import.meta.url), 'utf8');
  assert.match(source, /shortcutRuntime\.matches\('sendMessage', e\)/);
  assert.doesNotMatch(source, /e\.key === 'Enter' && !e\.shiftKey/);
});

test('ChatView 用统一分发器挂/摘窗口监听，按钮提示展示配置后的快捷键', () => {
  const source = readFileSync(new URL('../src/views/chat/ChatView.vue', import.meta.url), 'utf8');
  assert.match(source, /useGlobalShortcuts\(\(\) => \(\{/);
  assert.match(source, /void loadShortcutBindings\(\)/);
  assert.match(source, /:title="togglePreviewPanelTitle"/);
  // 旧的单键专用监听必须彻底下线，否则 Ctrl+\ 会被两条路径各处理一次
  assert.doesNotMatch(source, /handlePreviewShortcutKeydown/);
});
