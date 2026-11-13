import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('右上角控制栏与预览面板过渡动画契约', () => {
  const chatViewSrc = fs.readFileSync(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');
  const panelSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/FilePreviewPanel.vue'), 'utf8');
  const tabsSrc = fs.readFileSync(path.resolve(__dirname, '../src/composables/useUnifiedPreviewTabs.ts'), 'utf8');

  // 1. 顶部横条：justify-between 两端分布，左会话名、右预览切换按钮（不再是盖在消息上的绝对定位胶囊）
  assert.match(
    chatViewSrc,
    /<header\s+data-test="chat-header-bar"[\s\S]*?justify-between[\s\S]*?headerSessionName[\s\S]*?data-test="chat-preview-toggle"/,
    '顶部横条必须 justify-between 布局：左侧会话名、右侧预览开关'
  );
  assert.doesNotMatch(
    chatViewSrc,
    /absolute right-4 top-3 z-30 inline-flex/,
    '预览入口不得再退化成悬浮在消息上的绝对定位胶囊'
  );
  // 横条常驻：它一旦跟着面板开合消失/出现，消息区高度会跳 44px（正是「不丝滑」的一半来源）。
  assert.doesNotMatch(
    chatViewSrc,
    /<header[\s\S]{0,200}?v-if="!previewPanelVisible"/,
    '顶部横条不得按预览面板显隐做 v-if，否则开合时消息区会跳一行高度'
  );

  // 2. 验证保留了稳定的测试钩子
  assert.match(chatViewSrc, /data-test="chat-preview-toggle"/, '必须保留右侧预览开关测试钩子');
  assert.match(chatViewSrc, /data-test="token-audit-entry"/, '必须保留用量审计测试钩子');

  // 3. 面板显隐只有一条链路：宿主不发 Transition、不改 v-if，显隐由 :visible 交给面板自己过渡
  assert.match(
    chatViewSrc,
    /<FilePreviewPanel\s+v-if="panelMounted"[\s\S]{0,120}?:visible="previewPanelVisible"/,
    '面板必须以 :visible 驱动显隐（v-if 只管挂载），否则收起动画没有机会播完'
  );
  assert.doesNotMatch(chatViewSrc, /<Transition name="preview-panel-slide">/, '滑动过渡归面板自己，宿主不得再包一层 Transition');
  assert.doesNotMatch(chatViewSrc, /\.preview-panel-slide-enter-active/, '宿主里不得再留 preview-panel-slide 死样式');
  assert.doesNotMatch(chatViewSrc, /\.panel-entries-fade-enter-active/, '横条常驻后 panel-entries-fade 是死样式，必须删掉');

  // 4. 可见性是单一真源：统一由 previewPanelOpen 驱动
  assert.match(tabsSrc, /const previewPanelOpen = ref\(false\);/, '面板展开态必须有独立真源');
  assert.match(
    chatViewSrc,
    /const previewPanelVisible = computed<boolean>\(\(\) => previewPanelOpen\.value\);/,
    '可见性必须只由 previewPanelOpen 派生'
  );

  // 5. 面板侧：宽度过渡 + 固定宽度画布（裁切窗口），内容不随每一帧重排
  const ruleBody = (code: string, selector: string): string => {
    const at = code.indexOf(selector);
    assert.ok(at >= 0, `缺少规则：${selector}`);
    return code.slice(code.indexOf('{', at) + 1, code.indexOf('}', at));
  };
  const shellRule = ruleBody(panelSrc, '.file-preview-panel {');
  assert.match(shellRule, /width: 0;/, '外壳默认宽度必须是 0（收起态），展开才有起点可插值');
  assert.match(shellRule, /overflow: hidden;/, '外壳必须裁掉画布溢出的部分，宽度动画才只改裁切窗口');
  assert.match(shellRule, /transition: width 240ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/, '外壳必须有一次性的宽度过渡');
  assert.match(ruleBody(panelSrc, '.file-preview-panel.is-resizing {'), /transition: none;/, '拖拽调宽必须没有过渡');
  assert.match(ruleBody(panelSrc, '.panel-canvas {'), /width: var\(--lx-preview-canvas-w, 540px\)/, '画布必须固定宽度，不能跟随外壳每帧重排');
  assert.match(panelSrc, /<div class="panel-canvas">/, '内容必须落在固定宽度画布里');
  assert.doesNotMatch(panelSrc, /position: absolute; inset: 0; z-index: 40; width: 100%;/, '最大化不得再靠绝对定位（无法参与宽度过渡）');

  // 6. 原生网页视图：滑动期间必须停更（它浮在 DOM 上、不参与过渡也不被裁切）
  assert.match(panelSrc, /:sliding="isSliding \|\| resizing"/, '页面模式必须拿到滑动信号');
  const pageSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/ProjectPagePreview.vue'), 'utf8');
  assert.match(pageSrc, /const scheduleViewport = \(\): void => \{\s*if \(props\.sliding\) return;/, '滑动期间必须拦掉逐帧布局同步');
  assert.match(pageSrc, /watch\(\(\) => props\.sliding, applySliding\)/, '滑动结束必须补一次对位');
});

test('正文文件链接点开后预览面板必须自动展开', () => {
  const chatViewSrc = fs.readFileSync(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');
  const tabsSrc = fs.readFileSync(path.resolve(__dirname, '../src/composables/useUnifiedPreviewTabs.ts'), 'utf8');

  // 1. 注入给 MarkdownRenderer / ToolCallRenderer / TurnFileChangeCard 的必须是包装过的入口。
  assert.doesNotMatch(
    chatViewSrc,
    /provide\(FILE_PREVIEW_KEY, openFilePreview\)/,
    '不得把 useFilePreview 的 openFilePreview 直接 provide：它不展开面板'
  );
  assert.match(
    chatViewSrc,
    /provide\(FILE_PREVIEW_KEY, openFilePreviewInPanel\)/,
    'FILE_PREVIEW_KEY 必须注入会同时展开面板的包装入口'
  );

  // 2. 包装入口必须三件事齐全：开标签、激活统一文件 tab、展开面板。
  const start = tabsSrc.indexOf('const openFilePreviewInPanel = ');
  assert.ok(start >= 0, '缺少 openFilePreviewInPanel 实现');
  const body = tabsSrc.slice(start, tabsSrc.indexOf('\n  };', start));
  assert.match(body, /openFilePreview\(request\);/, '包装入口必须先开标签');
  assert.match(body, /activeTabKey\.value = key;/, '包装入口必须激活对应统一文件 tab');
  assert.match(body, /showPreviewPanel\(\);/, '包装入口必须展开面板（唯一展开入口 showPreviewPanel）');

  // 3. 宿主自己的打开路径也不许绕过包装入口（日志跳转曾直接调裸函数）。
  assert.doesNotMatch(
    chatViewSrc,
    /openFilePreview\(\{/,
    '宿主内所有打开文件的调用都必须走 openFilePreviewInPanel，不得直呼裸 openFilePreview'
  );
});

test('diff 预览框文字按照代码风格与语法高亮渲染契约', () => {
  const panelSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/FilePreviewPanel.vue'), 'utf8');

  // 1. 验证引入了 highlight.js
  assert.match(panelSrc, /import hljs from 'highlight\.js'/, 'FilePreviewPanel 必须引入 highlight.js');

  // 2. 验证模板中 diff-text 使用了 v-html="highlightLine(line.text)"
  assert.match(
    panelSrc,
    /<span class="diff-text" v-html="highlightLine\(line\.text\)"><\/span>/,
    'diff-text 必须通过 highlightLine 进行代码风格高亮渲染'
  );

  // 3. 验证 diff-preview CSS 样式使用了标准代码等宽字体、tab-size、行号分隔线
  assert.match(panelSrc, /font-family: var\(--font-lx-code/, 'diff-preview 必须优先消费 --font-lx-code 并在未声明时兜底等宽代码字体');
  assert.match(panelSrc, /tab-size: 4/, 'diff-preview 必须设置 tab-size: 4 规范代码缩进');
  assert.match(panelSrc, /border-right: 1px solid var\(--file-line\)/, 'diff 行号列必须具有右侧分隔线规范排版');

  // 4. 验证定义了 hljs 语法高亮类选择器（支持明暗双色）
  assert.match(panelSrc, /\.diff-preview :deep\(\.hljs-keyword\)/, '必须为 diff 代码关键词配置高亮样式');
  assert.match(panelSrc, /\.diff-preview :deep\(\.hljs-comment\)/, '必须为 diff 注释行配置高亮样式');
  assert.match(panelSrc, /\.file-preview-panel\.is-dark \.diff-preview :deep\(\.hljs-keyword\)/, '深色模式下必须提供对应的代码高亮');
});

test('控制栏关闭防漂移与侧边栏防挤压布局契约', () => {
  const chatViewSrc = fs.readFileSync(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');
  const sidebarSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/Sidebar.vue'), 'utf8');
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/App.vue'), 'utf8');
  const previewSrc = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/ProjectPagePreview.vue'), 'utf8');

  // 1. 横条常驻后不再有入场过渡；这里改为钉住「滑动时长是同一份真源」：CSS 与 JS 都必须是 240ms
  assert.match(
    chatViewSrc,
    /<FilePreviewPanel\s+v-if="panelMounted"/,
    '面板挂载与显隐必须分离（v-if 只管挂载）'
  );
  const panelSrcForTiming = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/FilePreviewPanel.vue'), 'utf8');
  assert.match(panelSrcForTiming, /const SLIDE_MS = 240;/, 'JS 侧滑动时长常量必须存在');
  assert.match(panelSrcForTiming, /transition: width 240ms/, 'CSS 侧滑动时长必须与 SLIDE_MS 一致');

  // 2. 聊天主视窗 flex 容器必须具有 min-w-0 约束，防止挤压侧边栏
  assert.match(
    chatViewSrc,
    /<div class="relative z-10 flex-1 min-w-0 flex h-full overflow-hidden">/,
    'ChatView 主视窗 flex-1 容器必须声明 min-w-0 避免内容撑大挤压侧栏'
  );

  // 3. Sidebar aside 根节点必须包含 shrink-0 防止被 flex 兄弟元素挤压变形
  assert.match(
    sidebarSrc,
    /<aside[\s\S]*?shrink-0/,
    'Sidebar 根容器必须具有 shrink-0 防止弹性挤压'
  );

  // 4. App.vue desktop-content 必须禁用横向滚动，防止页面横向漂移
  assert.match(
    appSrc,
    /\.desktop-content\s*\{[\s\S]*?overflow-x:\s*hidden/,
    'App.vue desktop-content 必须配置 overflow-x: hidden 杜绝横向漂移'
  );

  // 5. ProjectPagePreview 禁止对父级容器调用 scrollIntoView 导致整页横向滑动
  assert.doesNotMatch(
    previewSrc,
    /\.parentElement\?\.scrollIntoView/,
    'ProjectPagePreview 禁止对父容器调用 scrollIntoView，应操作容器 scrollLeft'
  );

  // 6. 面板横向让位必须靠「宽度」过渡（transform 只会浮在对话上，右侧不会让出空间）
  assert.match(
    fs.readFileSync(path.resolve(__dirname, '../src/components/chat/FilePreviewPanel.vue'), 'utf8'),
    /transition: width 240ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/,
    '面板宽度过渡必须存在，否则 flexbox 会瞬间扣减宽度挤压左侧正文区'
  );
});
