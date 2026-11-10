import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('右上角控制栏与预览面板过渡动画契约', () => {
  const chatViewSrc = fs.readFileSync(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');

  // 1. 验证右上角多功能入口使用了 Transition 胶囊浮动栏
  assert.match(
    chatViewSrc,
    /<Transition name="panel-entries-fade">\s*<div\s+v-if="!previewPanelVisible"[\s\S]*?backdrop-blur-md/,
    '右上角控制栏必须使用 panel-entries-fade 过渡并呈现一体化毛玻璃胶囊形态'
  );

  // 2. 验证保留了稳定的测试钩子与四个入口
  assert.match(chatViewSrc, /data-test="chat-project-page-entry"/, '必须保留项目页面预览测试钩子');
  assert.match(chatViewSrc, /data-test="chat-design-preview-entry"/, '必须保留设计原型预览测试钩子');
  assert.match(chatViewSrc, /data-test="token-audit-entry"/, '必须保留用量审计测试钩子');
  assert.match(chatViewSrc, /openFilePreviewPanel/, '必须保留文件预览入口');

  // 3. 验证 FilePreviewPanel 被 Transition 抽屉动画包裹，且 v-show 契约完好
  assert.match(
    chatViewSrc,
    /<Transition name="preview-panel-slide">\s*<FilePreviewPanel[\s\S]*?v-show="previewPanelVisible"/,
    'FilePreviewPanel 必须被 preview-panel-slide 平滑过渡包裹并保留 v-show 避免 iframe 销毁'
  );

  // 4. 验证 scoped CSS 中声明了对应的过渡动画类
  assert.match(chatViewSrc, /\.preview-panel-slide-enter-active/, '必须包含 preview-panel-slide 过渡样式');
  assert.match(chatViewSrc, /\.panel-entries-fade-enter-active/, '必须包含 panel-entries-fade 过渡样式');
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

  // 1. 控制栏入场过渡必须包含延迟，等待右侧面板收起完成，禁止在收缩态中央瞬间闪现
  assert.match(
    chatViewSrc,
    /\.panel-entries-fade-enter-active\s*\{[\s\S]*?0\.28s/,
    '右上角控制栏 enter-active 必须延迟 0.28s 等待抽屉收起完毕再淡入'
  );

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

  // 6. preview-panel-slide 必须基于宽度过渡，避免 flexbox 瞬间扣减宽度挤压左侧正文区
  assert.match(
    chatViewSrc,
    /\.preview-panel-slide-enter-active[\s\S]*?width\s+0\.28s/,
    'preview-panel-slide 必须基于宽度过渡，避免 flexbox 瞬间扣减宽度挤压左侧正文区'
  );
});
