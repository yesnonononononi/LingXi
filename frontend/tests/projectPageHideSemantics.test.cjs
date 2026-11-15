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
  const tabsComposable = stripComments(await read('src/composables/useUnifiedPreviewTabs.ts'));
  const hideBody = section(tabsComposable, 'const closePreviewPanel = (): void => {', '\n  };');
  assert.match(hideBody, /pagePreview\.hide\(\)/, '✕ 收起必须走 hide()');
  assert.doesNotMatch(hideBody, /pagePreview\.close\(\)/, '✕ 收起不得销毁网页会话');
});

test('浏览器生命周期独立于会话与 ChatView：切会话不销毁网页，实例由 App 持有', async () => {
  const appVue = stripComments(await read('src/App.vue'));
  assert.match(appVue, /useProjectPagePreview\(\)/, 'App.vue 必须创建全局浏览器实例');
  assert.match(appVue, /provide\(PROJECT_PAGE_PREVIEW_KEY,\s*pagePreview\)/, 'App.vue 必须向下注入浏览器实例');

  const chatView = stripComments(await read('src/views/chat/ChatView.vue'));
  assert.match(chatView, /inject\(PROJECT_PAGE_PREVIEW_KEY,\s*null\)\s*\?\?\s*useProjectPagePreview\(\)/, 'ChatView 必须优先复用 App 注入的浏览器实例');
  assert.doesNotMatch(chatView, /resetSessionPages\s*\(/, '切换会话/工作区不得再销毁网页实例');
  assert.doesNotMatch(chatView, /pagePreview\.close\s*\(/, 'ChatView 不得销毁全局网页实例');
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

test('ProjectPagePreview 隐藏或滑动时必须使 lastLayout 失效，且 visible 受 preview.open.value 约束', async () => {
  const pagePreview = stripComments(await read('src/components/chat/ProjectPagePreview.vue'));
  const syncBody = section(pagePreview, 'const syncViewport = (): void => {', '\n};');
  assert.match(syncBody, /visible:\s*preview\.open\.value\s*&&\s*props\.active/, 'visible 必须受 preview.open.value 约束，避免隐藏期间污染 lastLayout');
  const slidingBody = section(pagePreview, 'const applySliding = (sliding: boolean): void => {', '\n};');
  assert.match(slidingBody, /lastLayout\s*=\s*'';/, '滑动隐藏必须清空 lastLayout 缓存');
});
