/** 收起面板不能销毁网页标签会话：这条契约横跨 ChatView 与 composable，单测只能覆盖后者。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const read = relative => fs.readFile(path.resolve(__dirname, '..', relative), 'utf8');
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const section = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `源码缺少片段：${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `片段未闭合：${start}`);
  return source.slice(from, to);
};

test('收起面板只隐藏，不销毁网页会话', async () => {
  const chatView = stripComments(await read('src/views/chat/ChatView.vue'));
  const hideBody = section(chatView, 'const closePreviewPanel = (): void => {', '\n};');
  assert.match(hideBody, /pagePreview\.hide\(\)/, '✕ 收起必须走 hide()');
  assert.doesNotMatch(hideBody, /pagePreview\.close\(\)/, '✕ 收起不得销毁网页会话');
});

test('切换会话/工作区仍然销毁网页会话（隔离边界不许被顺手改成 hide）', async () => {
  const chatView = stripComments(await read('src/views/chat/ChatView.vue'));
  const isolation = section(chatView, 'watch([localActiveId, localActiveWorkspaceId]', '\n});');
  assert.match(isolation, /pagePreview\.close\(\)/);
  assert.doesNotMatch(isolation, /pagePreview\.hide\(\)/);
});

test('hide 不换代次、不发 close 指令，且必须把隐藏布局发出去', async () => {
  const composable = stripComments(await read('src/composables/useProjectPagePreview.ts'));
  const hideBody = section(composable, 'const hide = (): void => {', '\n  };');
  assert.doesNotMatch(hideBody, /generation\.value \+= 1/, '收起不得前进代次（主进程据此销毁标签）');
  assert.doesNotMatch(hideBody, /action: 'close'/, '收起不得发 close 指令');
  assert.match(hideBody, /bridge\.layout\(/, '收起必须显式下发隐藏布局，否则原生视图会盖住界面');
});

test('重开只在会话已销毁时换代，布局允许收起后透传隐藏指令', async () => {
  const composable = stripComments(await read('src/composables/useProjectPagePreview.ts'));
  const openWatch = section(composable, 'watch(open, value => {', "\n  }, {flush: 'sync'});");
  assert.match(openWatch, /if \(!sessionAlive\) \{\s*\n\s*generation\.value \+= 1;/, '重开必须受 sessionAlive 守卫');
  const layoutBody = section(composable, 'const updateLayout = (value: ProjectPageLayout): void => {', '\n  };');
  assert.match(layoutBody, /const applicable = open\.value \|\| !value\.visible;/, '收起后的隐藏指令必须透传');
});
