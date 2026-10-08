import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, highlightMarkdownInput } from '../src/utils/markdownInputHighlight';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('1. escapeHtml 正确转义常见 HTML 特殊字符，防范 XSS', () => {
  const raw = '<script>alert("xss") & test\'</script>';
  const escaped = escapeHtml(raw);
  assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;) &amp; test&#39;&lt;/script&gt;');
});

test('2. highlightMarkdownInput 正确高亮行内代码（对齐用户截图中的 `find-skills` 场景）', () => {
  const input = '尝试寻找并安装`find-skills`工具';
  const html = highlightMarkdownInput(input);

  // 必须保留原始字符序列且字符未被篡改
  assert.ok(html.includes('尝试寻找并安装'));
  assert.ok(html.includes('`find-skills`'));
  assert.ok(html.includes('工具'));
  // 必须包含高亮样式标签
  assert.match(html, /<span class="[^"]*text-emerald-[^"]*font-mono[^"]*">`find-skills`<\/span>/);
});

test('3. 行内代码内部包含星号时，不被误判为斜体或粗体', () => {
  const input = '计算表达式 `a * b * c` 的结果';
  const html = highlightMarkdownInput(input);

  assert.match(html, />`a \* b \* c`<\/span>/);
  assert.equal(html.includes('<em'), false, '行内代码中的星号绝不能被解析为斜体 <em>');
});

test('4. 粗体、斜体、删除线与标题均可正确解析', () => {
  const input = '# 主标题\n**加粗** 与 *斜体* 以及 ~~删除线~~';
  const html = highlightMarkdownInput(input);

  assert.match(html, /<span class="font-bold text-sky-[^"]*"># 主标题<\/span>/);
  assert.match(html, /<strong class="font-bold[^"]*">\*\*加粗\*\*<\/strong>/);
  assert.match(html, /<em class="italic[^"]*">\*斜体\*<\/em>/);
  assert.match(html, /<span class="line-through[^"]*">~~删除线~~<\/span>/);
});

test('5. 末尾带有换行符时自动追加 <br>，确保高度与原生 textarea 完全一致', () => {
  const input = '第一行\n第二行\n';
  const html = highlightMarkdownInput(input);

  assert.ok(html.endsWith('<br>'), '末尾换行必须补齐 <br> 保证 pre-wrap 换行盒高度对齐');
});

test('6. ChatInputArea.vue 必须集成 TipTap 所见即所得 Markdown 渲染并彻底移除预览功能', () => {
  const chatInputPath = path.resolve(__dirname, '../src/components/chat/ChatInputArea.vue');
  const vueContent = fs.readFileSync(chatInputPath, 'utf8');

  // 必须集成 TipTap 编辑器组件与 Markdown 扩展
  assert.match(
    vueContent,
    /EditorContent/,
    '输入框必须挂载 TipTap EditorContent 组件'
  );
  assert.match(
    vueContent,
    /from '@tiptap\/vue-3'/,
    '必须引入 @tiptap/vue-3 库'
  );
  assert.match(
    vueContent,
    /from 'tiptap-markdown'/,
    '必须引入 tiptap-markdown 扩展'
  );

  // 严格守卫：预览功能必须彻底移除，禁止残留
  assert.equal(
    vueContent.includes('togglePreview'),
    false,
    '工具栏与脚本必须彻底移除 togglePreview 预览切换操作'
  );
  assert.equal(
    vueContent.includes('isPreviewMode'),
    false,
    '输入框状态中禁止残留 isPreviewMode 预览状态'
  );
  assert.equal(
    vueContent.includes('MarkdownRenderer'),
    false,
    '输入框区域禁止残留独立的 MarkdownRenderer 预览容器'
  );
});

