import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_WINDOW_TITLE, resolveWindowTitle} from '../src/utils/windowTitle.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');

test('resolveWindowTitle 直接返回裁剪后的会话名且不拼接 - LX', () => {
  assert.equal(resolveWindowTitle('修复登录问题'), '修复登录问题');
  assert.equal(resolveWindowTitle('  重构路由  '), '重构路由');
  assert.equal(resolveWindowTitle(''), DEFAULT_WINDOW_TITLE);
  assert.equal(resolveWindowTitle('   '), DEFAULT_WINDOW_TITLE);
  assert.equal(resolveWindowTitle(null), DEFAULT_WINDOW_TITLE);
  assert.equal(resolveWindowTitle(undefined), DEFAULT_WINDOW_TITLE);
});

test('ChatView 将 headerSessionName 同步到 document.title 并在卸载时恢复默认值', () => {
  const chatView = fs.readFileSync(path.join(frontendRoot, 'src/views/chat/ChatView.vue'), 'utf8');
  const useChatViewIndex = chatView.indexOf('} = useChatView(');
  const watchIndex = chatView.indexOf('watch(headerSessionName,');
  assert.ok(useChatViewIndex >= 0 && watchIndex > useChatViewIndex, 'immediate watch 必须排在 useChatView 解构 currentActiveSession 之后');
  assert.match(chatView, /watch\(headerSessionName,\s*\(sessionName\)\s*=>\s*\{[\s\S]*?document\.title\s*=\s*resolveWindowTitle\(sessionName\)/);
  assert.match(chatView, /onBeforeUnmount\(\(\)\s*=>\s*\{[\s\S]*?document\.title\s*=\s*DEFAULT_WINDOW_TITLE/);
});

test('Electron 主进程未拦截 page-title-updated，确保 document.title 自动同步到任务栏预览标题', () => {
  const mainCjs = fs.readFileSync(path.join(frontendRoot, 'electron/main.cjs'), 'utf8');
  assert.doesNotMatch(mainCjs, /page-title-updated/);
});
