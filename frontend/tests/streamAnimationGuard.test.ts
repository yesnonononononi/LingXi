import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const streamCssPath = path.resolve(__dirname, '../src/styles/stream-animation.css');
const markdownRendererPath = path.resolve(__dirname, '../src/components/chat/MarkdownRenderer.vue');
const projectRoot = path.resolve(__dirname, '..');
const styleCssPath = path.resolve(projectRoot, 'src/style.css');

/** 抽出模板里所有 `v-if="..."` 的条件表达式（空白归一，避免被属性换行/缩进影响）。 */
function extractVIfConditions(source: string): string[] {
  return [...source.matchAll(/\bv-if="([^"]*)"/g)].map(match => match[1].replace(/\s+/g, ' ').trim());
}

/** 递归收集 src 下所有 .vue 文件。 */
function walkVueFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkVueFiles(full, out);
    else if (name.endsWith('.vue')) out.push(full);
  }
  return out;
}

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

test('2. MarkdownRenderer.vue 仅在尚未产出正文时显示思考占位提示，正文出现后不得再有额外占位元素（避免孤立空行或与末尾文本重叠）', () => {
  const vueContent = fs.readFileSync(markdownRendererPath, 'utf8');

  // ── 金丝雀（正对照）──────────────────────────────────────────────────────────
  // 必须先证明「真的读到了这个 .vue 文件」且「后面的正则所依赖的锚点确实存在」，
  // 否则正则写错（属性换行、空格数量不符、路径错）会让断言恒真/恒假却毫无提示。
  // 注意：金丝雀只校验"文件读到了、锚点在"，不校验业务意图 —— 业务意图留给下面的断言，
  // 否则金丝雀会把意图断言挡在后面，导致意图断言永远测不到（变异无法击穿）。
  assert.ok(vueContent.length > 0, '未读到 MarkdownRenderer.vue 内容（金丝雀）');
  assert.match(vueContent, /<template>/, '金丝雀：应读到 SFC 模板段');
  assert.match(vueContent, /renderedHtml/, '金丝雀：文件内应存在 renderedHtml 标识（正则依赖的锚点）');
  assert.match(
    vueContent,
    /markdown-stream-flow/,
    '金丝雀：根容器应带 markdown-stream-flow（与用例 1 的流式样式对应）'
  );

  // ── 真实意图 1：思考占位的门控必须是 props.isThinking && !renderedHtml ─────────
  // 去掉 !renderedHtml ⇒ 正文已产出时仍会渲染占位，与末尾文本重叠并制造孤立空行。
  const conditions = extractVIfConditions(vueContent);
  assert.ok(
    conditions.includes('props.isThinking && !renderedHtml'),
    '思考占位必须由 `props.isThinking && !renderedHtml` 门控：缺少 !renderedHtml 会在正文产出后残留占位元素'
  );

  // ── 真实意图 2：占位内容是 GradientText + i18n 文案，而非已废弃的 typing-cursor ─
  const placeholderBlock = /<div\s+v-if="props\.isThinking\s*&&\s*!renderedHtml"[^>]*>([\s\S]*?)<\/div>/g
    .exec(vueContent);
  assert.notEqual(placeholderBlock, null, '未解析到受 !renderedHtml 门控的占位容器（选择器变了？）');
  assert.match(placeholderBlock![1], /<GradientText/, '占位提示必须是 GradientText 组件');
  assert.match(
    placeholderBlock![1],
    /t\('chat\.message\.exploringShort'\)/,
    '占位提示文案必须走 i18n key chat.message.exploringShort'
  );

  // ── 真实意图 3：占位与正文容器互斥（正文容器同样用 renderedHtml 门控）─────────
  // 两个容器若同时成立，正文下方会多出一个占位元素 ⇒ 孤立空行。
  assert.match(
    vueContent,
    /<div\s+v-if="renderedHtml"[\s\S]*?class="markdown-body"/,
    '正文容器必须由 v-if="renderedHtml" 门控，与思考占位互斥'
  );
  assert.ok(conditions.includes('renderedHtml'), '缺少 v-if="renderedHtml" 的正文容器门控');
  assert.ok(
    !conditions.includes('props.isThinking'),
    '占位不得退化为只判断 props.isThinking（会与正文同时渲染，造成孤立空行）'
  );

  // ── 真实意图 4：不再使用已废弃的 typing-cursor 类 ─────────────────────────────
  assert.doesNotMatch(
    vueContent,
    /class="[^"]*\btyping-cursor\b/,
    'typing-cursor 类已废弃，正文尾声由 stream-animation.css 的 p:last-child::after 接管'
  );
});

test('3. .typing-cursor 的样式不得成为沉默债务：全 src 已无 .vue 消费方，且该债务必须可见', () => {
  // ── 金丝雀（正对照）──────────────────────────────────────────────────────────
  // 「检索不到」类断言最容易假绿（正则写错、路径写错、walk 没进子目录都会恒真）。
  // 先证明同一个检测函数在「确实含该类名的样本」上能命中，否则下面的 doesNotMatch 不成立。
  const detector = (source: string): boolean => /class="[^"]*\btyping-cursor\b/.test(source);
  assert.equal(
    detector('<span class="typing-cursor" />'),
    true,
    '金丝雀：检测函数必须能命中含 typing-cursor 类的样本，否则下面的「无消费方」断言恒真'
  );
  assert.equal(
    detector('class="flex typing-cursor ml-0"'),
    true,
    '金丝雀：多 class 场景也必须命中'
  );
  assert.equal(detector('<span class="cursor-typing" />'), false, '金丝雀：不得把近似类名误判为消费方');

  // ── 债务记账：样式规则仍在，必须显式可见 ─────────────────────────────────────
  const styleCss = fs.readFileSync(styleCssPath, 'utf8');
  assert.ok(styleCss.length > 0, '金丝雀：未读到 src/style.css');
  assert.match(
    styleCss,
    /\.typing-cursor::after\s*\{/,
    'src/style.css 仍定义 .typing-cursor::after —— 这是一笔已登记的样式债务；' +
      '若已清理该规则，请同步更新本用例（把它标为「债务已偿还」），不要静默删除断言'
  );

  // ── 核心断言：全 src 不再有任何 .vue 使用 typing-cursor 类 ──────────────────
  const vueFiles = walkVueFiles(path.resolve(projectRoot, 'src'));
  assert.ok(
    vueFiles.length > 50,
    `金丝雀：应递归收集到数十个 .vue 文件，实际 ${vueFiles.length} 个（walk 逻辑可能失效）`
  );

  const offenders = vueFiles.filter(file => detector(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(
    offenders.map(file => path.relative(projectRoot, file)),
    [],
    '以下 .vue 仍在消费已废弃的 typing-cursor 类；样式规则已无消费方，必须删除消费方或偿还债务'
  );
});
