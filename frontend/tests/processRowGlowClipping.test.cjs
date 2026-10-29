const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * dark 模式「过程文字出现长方形灰色盒子」的源码级守卫。
 *
 * <p>实测根因：灰盒子 = 文字发光阴影（text-shadow）被 overflow 裁剪成矩形，元素背景本身是透明的。
 * 两处裁剪来源：</p>
 * <ul>
 *   <li>头部行容器带 {@code overflow-hidden}（实测 479×24），把整行光晕裁成矩形；</li>
 *   <li>行内 {@code truncate} 按钮（文件路径 / 描述文字）自身即 {@code overflow:hidden}，
 *       把光晕切成文字框大小的矩形。</li>
 * </ul>
 *
 * <p>因此本守卫锁定三条契约（均为「修复前红、修复后绿」的源码事实，不依赖渲染环境）：</p>
 * <ol>
 *   <li>{@code truncate} 与 {@code text-glow-*} 不得出现在同一元素的同一 class 里；</li>
 *   <li>头部行容器不得再用 {@code overflow-hidden} 防溢出（改由 {@code min-w-0} + 子元素 {@code truncate} 承担）；</li>
 *   <li>头部行容器的样式函数（{@code toolRowHeaderClass}）dark 基底不得含 {@code text-glow-*}——
 *       text-shadow 是继承属性，挂在容器上等于粘到每个 {@code truncate} 子元素上。</li>
 * </ol>
 *
 * <p>同时留一条反向断言：发光设计本身不得被整体砍掉（style.css 里两档光晕仍存在），
 * 避免「为了消盒子把设计语言删了」这种假修复。</p>
 */

const ROOT = path.resolve(__dirname, '..');
const RENDERER = 'src/components/chat/process/ToolCallRenderer.vue';
const ROW_UI = 'src/utils/toolRowUi.ts';
const STYLE = 'src/style.css';

/** 读取仓库内源文件（相对 frontend/ 根）。 */
function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * 提取 SFC 模板里的所有「开标签」原文。
 *
 * <p>必须按元素聚合判定，不能按字符串字面量判定：同一元素常把截断类写在静态
 * {@code class="... truncate ..."}，把发光类写在 {@code :class="isDark ? '... text-glow-white'"}，
 * 分属两个字面量 —— 按字面量比对会漏判成假绿（本测试首版就踩过这个坑）。</p>
 */
function openingTags(source) {
  return source.match(/<[a-zA-Z][^<>]*>/g) || [];
}

/** 单个开标签内是否出现过某个类名（含 `truncate` / `overflow-hidden` 这类单值工具类）。 */
function hasToken(tag, token) {
  return new RegExp(`(^|[\\s'":?])${token}($|[\\s'"])`).test(tag);
}

test('过程行渲染：同一元素的 truncate 与 text-glow-* 不得共存', () => {
  const source = readSource(RENDERER);
  const tags = openingTags(source);

  // 金丝雀：模板里必须同时存在「发光元素」与「截断元素」，否则断言会因解析失败而假绿
  assert.notEqual(tags.length, 0, '未解析到任何开标签（锚点/解析失效）');
  assert.ok(
    tags.some(tag => /text-glow-[a-z]+/.test(tag)),
    '过程行应仍保留发光设计（不可裁剪的标题元素），未解析到任何 text-glow-* 类'
  );
  assert.ok(
    tags.filter(tag => hasToken(tag, 'truncate')).length > 0,
    '过程行应仍有承担省略号的 truncate 元素，未解析到（解析失效或设计被改坏）'
  );

  const offenders = tags.filter(tag => hasToken(tag, 'truncate') && /text-glow-[a-z]+/.test(tag));
  assert.deepEqual(
    offenders.map(tag => tag.replace(/\s+/g, ' ').slice(0, 160)),
    [],
    'truncate 元素自带 overflow:hidden，光晕会被裁成文字框大小的矩形灰盒'
  );
});

test('过程行头部容器：不得用 overflow-hidden 防溢出，截断职责归子元素', () => {
  const source = readSource(RENDERER);
  const anchor = '@click="toggle"';
  const at = source.indexOf(anchor);

  // 金丝雀：锚点改名会让整条断言落空
  assert.notEqual(at, -1, `锚点未命中：${anchor}（断言不成立，需同步更新本测试）`);

  const region = source.slice(at, at + 400);
  const classAttr = /class="([^"]*)"/.exec(region);
  assert.notEqual(classAttr, null, '头部行容器的静态 class 未解析到，断言不成立');

  const classes = classAttr[1];
  assert.match(classes, /(^|\s)min-w-0(\s|$)/, '防横向溢出应由 min-w-0 + 子元素 truncate 承担');
  assert.doesNotMatch(
    classes,
    /(^|\s)overflow-hidden(\s|$)/,
    '头部行容器不得带 overflow-hidden：它会把整行文字光晕裁成矩形（实测 479×24 灰盒）'
  );
});

/** 去掉注释（源码注释里会引用类名做说明，不能算进样式契约）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('头部行样式函数：toolRowHeaderClass 的 dark 基底不得含 text-glow-*', () => {
  const code = stripComments(readSource(ROW_UI));
  const at = code.indexOf('export function toolRowHeaderClass');
  assert.notEqual(at, -1, '锚点未命中：export function toolRowHeaderClass（断言不成立）');

  const end = code.indexOf('\n}', at);
  assert.notEqual(end, -1, 'toolRowHeaderClass 函数体未闭合，断言不成立');
  const body = code.slice(at, end);

  // 金丝雀：深色高亮色仍在（说明函数体被正确定位）
  assert.match(body, /text-zinc-200/, '函数体应保留 dark 高亮色 text-zinc-200');
  assert.doesNotMatch(
    body,
    /text-glow-/,
    'text-shadow 会继承给行内 truncate 子元素并被其裁剪成灰盒，容器基底不得承载发光'
  );
});

test('发光设计未被整体砍掉：style.css 仍定义 text-glow-subtle 与 text-glow-white', () => {
  const css = readSource(STYLE);
  assert.match(css, /\.text-glow-subtle\s*\{[^}]*text-shadow:/, 'text-glow-subtle 光晕定义被删除');
  assert.match(css, /\.text-glow-white\s*\{[^}]*text-shadow:/, 'text-glow-white 光晕定义被删除');
});
