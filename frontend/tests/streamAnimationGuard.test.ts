import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const streamCssPath = path.resolve(__dirname, '../src/styles/stream-animation.css');
const markdownRendererPath = path.resolve(__dirname, '../src/components/chat/MarkdownRenderer.vue');

test('1. stream-animation.css 绝不能在流式 Markdown 的尾部元素挂载模糊或位移动画（防止表格与长文本闪烁与模糊）', () => {
  const cssContent = fs.readFileSync(streamCssPath, 'utf8');

  // 严禁匹配 .markdown-stream-flow.is-streaming .markdown-body > *:last-child 附带 animation
  assert.equal(
    /\.markdown-stream-flow\.is-streaming\s+\.markdown-body\s*>\s*\*:last-child\s*\{[^}]*animation/i.test(cssContent),
    false,
    '流式 markdown 容器下的 *:last-child 绝不能挂载动画，否则高频 innerHTML 刷新会导致整块内容永久陷入模糊与闪烁'
  );

  // 确保流式打字光标存在且附着在末尾段落/列表/标题之后
  assert.match(
    cssContent,
    /\.markdown-stream-flow\.is-streaming\s+\.markdown-body\s*>\s*p:last-child::after/,
    '必须通过 ::after 伪元素内联跟进流式打字光标'
  );
});

test('2. MarkdownRenderer.vue 仅在尚未产出正文时显示首字符占位光标，避免与末尾文本流重叠或产生孤立空行', () => {
  const vueContent = fs.readFileSync(markdownRendererPath, 'utf8');

  assert.match(
    vueContent,
    /<span\s+v-if="props\.isThinking\s*&&\s*!renderedHtml"\s+class="typing-cursor/,
    '打字光标必须受 !renderedHtml 门控，正文出现后交由末尾伪元素内联跟进'
  );
});
