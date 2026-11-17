import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatTogglePreviewShortcut,
  isTogglePreviewShortcut,
  type PreviewShortcutEvent,
} from '../src/utils/previewShortcut.ts';

function buildKeyEvent(overrides: Partial<PreviewShortcutEvent> = {}): PreviewShortcutEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    key: '\\',
    code: 'Backslash',
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides,
  };
}

test('Ctrl+\\ 与 Cmd+\\ 命中切换预览面板快捷键', () => {
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true })), true);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ metaKey: true })), true);
  // 中文输入法下 key 可能变为 '、'，通过 code 仍应命中
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, key: '、', code: 'Backslash' })), true);
});

test('修饰键组合、长按重复、输入法组字或已阻止事件不触发', () => {
  assert.equal(isTogglePreviewShortcut(buildKeyEvent()), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, altKey: true })), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, repeat: true })), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, isComposing: true })), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, defaultPrevented: true })), false);
  assert.equal(isTogglePreviewShortcut(buildKeyEvent({ ctrlKey: true, key: 'b', code: 'KeyB' })), false);
});

test('平台快捷键展示文案按 darwin 与其他平台区分', () => {
  assert.equal(formatTogglePreviewShortcut('darwin'), '⌘\\');
  assert.equal(formatTogglePreviewShortcut('win32'), 'Ctrl+\\');
  assert.equal(formatTogglePreviewShortcut(undefined), 'Ctrl+\\');
});

test('ChatView 注册并清理全局快捷键监听且在按钮提示中展示快捷键', () => {
  const chatViewSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/views/chat/ChatView.vue'),
    'utf8'
  );
  assert.match(chatViewSrc, /isTogglePreviewShortcut\(event\)/);
  assert.match(chatViewSrc, /window\.addEventListener\('keydown', handlePreviewShortcutKeydown\)/);
  assert.match(chatViewSrc, /window\.removeEventListener\('keydown', handlePreviewShortcutKeydown\)/);
  assert.match(chatViewSrc, /:title="togglePreviewPanelTitle"/);
});
