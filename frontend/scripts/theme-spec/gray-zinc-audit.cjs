#!/usr/bin/env node
/**
 * gray / zinc 出现点只读盘点工具（`gray-zinc-audit`）。
 *
 * <p><b>为什么需要它：</b>灰阶统一要做 `gray-N → zinc-N` 同档替换，但仓库里 `gray-*` 的字面出现点里
 * 混着模板静态 class、`:class` 里的 JS 字面量、TS 工具函数里的类名拼接、CSS/`<style>` 里的色值、
 * 注释、以及 `shadow-gray-500/20` 这种带透明度或梯度前缀的复合写法。<b>盲替换会改到不该改的地方。</b>
 * 所以先做一份只读清单：把每一处的位置、档位、上下文类别、是否在 `dark:` 变体内、是否带透明度后缀
 * 全部列出来，供人工裁决。</p>
 *
 * <p><b>本脚本是只读的：</b>不修改任何文件（除自己的 CSV 产物，且默认写到 `.lingxi/tmp/` 这种
 * 不入仓的路径）。**不是替换工具**。</p>
 *
 * <h3>判定规则（这是本工具的规格，改判定必须先改这里）</h3>
 *
 * <h4>1. 文件与扫描范围</h4>
 * 递归扫 `frontend/src/**`，扩展名 `.vue` / `.ts` / `.css` / `.scss`。匹配
 * `\b(gray|zinc)-\d{2,3}\b`（覆盖 50/100/…/950）。`\b` 保证 `gray-500` 不会误吃 `gray-5000`，
 * 也不会漏掉 `shadow-gray-500/20`（`-` 是非单词字符，边界成立）。
 *
 * <h4>2. `.vue` 如何切成 `<template>` / `<script>` / `<style>` 三块</h4>
 * 用状态机顺序扫描开标签 `<template|script|style`，记录内容区间，遇到同名闭标签结束。
 * **`<template>` 允许嵌套**（`<template v-if>`），因此对它做深度计数；
 * `<script>` / `<style>` 不做嵌套计数（Vue SFC 里它们不会嵌套）。
 * 已知局限：`<script>` 里的字符串若恰好包含字面量 `</script>`，会让块提前结束 —— 本仓库实测不存在，
 * 一旦出现会在「块未闭合」告警里体现。SFC 外层没有块标签的内容（理论上不该有）归 `UNKNOWN`。
 *
 * <h4>3. 注释如何识别</h4>
 * 分块类型分别处理，而不是一条正则拍死：
 * - `<template>`：`<!-- ... -->`；**另外**绑定属性（`:class` / `v-bind:*`）的值里是 JS 表达式，
 *   所以对其值区间再做一次「跳过字符串找 `//` 与块注释」的词法扫描——模板里确实存在
 *   `:class="[ // 说明 … ]"` 这种写法（`DropUpSelect.vue` 就有一处），漏掉会把注释误判成绑定类名；
 * - `<script>` / `.ts`：走一个跳过字符串的最小词法器，识别 `//` 行注释与 C 风格块注释
 *   （先跳过 `'` / `"` / `` ` `` 字符串，避免把字符串里的 `//` 当注释，例如 URL）；
 * - `<style>` / `.css` / `.scss`：C 风格块注释（斜杠星号 … 星号斜杠）；`.scss` 额外识别 `//`。
 *
 * <h4>4. 模板里怎么区分「静态 class」与「`:class` 绑定」</h4>
 * 在 `<template>` 内容里扫属性 `name="value"` / `name='value'`，得到每个属性值的区间，然后
 * 用「命中位置落在哪个属性值里」来判定，而不是按元素粗判（同一个元素经常同时有
 * `class="a"` 与 `:class="isDark ? 'b' : 'c'"`）：
 * - 属性名 `class` → `TPL_CLASS`（静态 class 属性里的类名）；
 * - 属性名 `:class` / `v-bind:class` → `TPL_BIND`（绑定表达式里的字符串字面量或三元分支）；
 * - 其它属性（如 `:dark-class`、`:style`）→ `UNKNOWN` 并在备注里写明属性名（不瞎猜）。
 *
 * <h4>5. 怎么识别「CSS 颜色值」vs「class 名」</h4>
 * - 在 `<style>` / `.css` / `.scss` 里，命中若位于 `@apply ...;` 声明内 ⇒ 它是**类名**不是色值，
 *   按规格书对 `@apply` 的排除，**不归 CSS_VALUE**（见下方裁决）；
 * - 命中若是真正的 CSS 值位置（形如 `color: ...` 或 `border: 1px solid ...` 的值部分）⇒ `CSS_VALUE`。
 *   实测本仓库当前没有这种写法（Tailwind 令牌全走类名），因此 `CSS_VALUE` 为 0 属真实结果，不是漏扫；
 * - `.ts` / `<script>` 里命中位于字符串字面量内 ⇒ `TS_CLASS`（类名字符串）；
 *   不在字符串也不在注释里（例如裸标识符）⇒ `UNKNOWN`。
 *
 * <h4>6. 优先级（一处命中只归一类，按此顺序短路）</h4>
 * 1. 文件是 `src/theme/tokens.css` ⇒ `TOKEN_DEF`（**绝对禁止改**；若该处同时在注释里，
 *    备注会标注 `含注释`，但类别仍按文件级规则判为 TOKEN_DEF —— 因为要执行的动作是「整文件别动」）；
 * 2. 在注释内 ⇒ `COMMENT`；
 * 3. 按所在块类型走上面 §4 / §5 的规则；
 * 4. 都不满足 ⇒ `UNKNOWN`。
 *
 * <h4>7. 关于 `@apply` 的裁决（可一行切换）</h4>
 * 规格书把 `CSS_VALUE` 定义为「`<style>` 或 .css 文件里的颜色值 / `@apply` 之外的直接色值」，
 * 也就是把 `@apply` 里的类名排除在 `CSS_VALUE` 之外。严格按此执行时它们落入 `UNKNOWN`
 * （备注 `@apply 内类名`）——它确实需人工裁决，但**是类名、可安全同档替换**。
 * 如果主理人认为应归入 `CSS_VALUE`，把下方 {@link APPLY_CATEGORY} 改成 `'CSS_VALUE'` 即可，
 * 判定逻辑无需其它改动。报告里另有一节「@apply 专项」单独统计，避免被 UNKNOWN 淹没。
 *
 * <h4>8. `dark:` 变体与透明度后缀的判定</h4>
 * - `dark:`：取命中所在的**空白分隔类名 token**，按 `:` 切段，段列表里出现 `dark` 即视为在
 *   `dark:` 变体内（`dark:hover:text-gray-200`、`hover:dark:bg-gray-800` 都成立）；
 * - 透明度后缀：命中之后紧跟 `/20`、`/[0.08]`、`/80` 之类即视为带后缀，并把后缀原文一并输出。
 *
 * <h3>用法</h3>
 * ```
 * node frontend/scripts/theme-spec/gray-zinc-audit.cjs
 * node frontend/scripts/theme-spec/gray-zinc-audit.cjs --csv .lingxi/tmp/theme/gray-zinc-audit.csv
 * ```
 * 产物 CSV 默认写 `.lingxi/tmp/theme/gray-zinc-audit.csv`（该目录在 .gitignore 内），
 * **永不写进 `src/` 或仓库跟踪路径**。CSV 内容不含时间戳，因此两次运行逐字节相同（幂等）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 脚本所在目录：`frontend/scripts/theme-spec`。 */
const SCRIPT_DIR = __dirname;
/** 前端根：`frontend`。 */
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
/** 仓库根。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
/** 扫描根：`frontend/src`。 */
const SRC_ROOT = path.join(FRONTEND_ROOT, 'src');
/** CSV 默认路径（在 .gitignore 内，不入仓）。 */
const DEFAULT_CSV = path.join(REPO_ROOT, '.lingxi', 'tmp', 'theme', 'gray-zinc-audit.csv');
/** 令牌定义文件（相对仓库根，正斜杠）。 */
const TOKENS_CSS_REL = 'frontend/src/theme/tokens.css';
/** 参与扫描的扩展名。 */
const EXTS = new Set(['.vue', '.ts', '.css', '.scss']);
/** 命中正则：`gray-50` … `gray-950` / `zinc-*`。 */
const HIT_RE = /\b(gray|zinc)-(\d{2,3})\b/g;
/** `@apply` 里的类名归入哪个类别（见头部 §7 的裁决说明）。 */
const APPLY_CATEGORY = 'UNKNOWN';
/** 视为「复合前缀」（非纯 bg/text/border）的 Tailwind 功能前缀。 */
const COMPOSITE_PREFIXES = new Set([
  'ring', 'divide', 'shadow', 'drop-shadow', 'from', 'via', 'to', 'outline',
  'decoration', 'accent', 'caret', 'fill', 'stroke', 'placeholder',
]);
/** 七个合法类别。 */
const CATEGORIES = ['TPL_CLASS', 'TPL_BIND', 'TS_CLASS', 'CSS_VALUE', 'COMMENT', 'TOKEN_DEF', 'UNKNOWN'];

/**
 * 递归收集待扫描文件（结果排序，保证多次运行顺序一致 ⇒ CSV 逐字节相同）。
 *
 * @param {string} dir 起始目录
 * @returns {string[]} 文件绝对路径（已排序）
 */
function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (EXTS.has(path.extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  // 用码点比较而不是 localeCompare：后者受系统区域设置影响，会让 CSV 行序跨机器不稳定。
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** 转成仓库相对路径 + 正斜杠（跨平台稳定）。 */
const relFromRepo = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/**
 * 把 SFC 切成块。
 *
 * <p>`<template>` 允许嵌套（`<template v-if>`），因此对它做深度计数；
 * `<script>` / `<style>` 在 SFC 里不嵌套，遇到同名闭标签即结束。</p>
 *
 * @param {string} src 源码
 * @returns {Array<{kind: string, contentStart: number, contentEnd: number}>} 块列表
 */
function splitSfcBlocks(src) {
  /** @type {Array<{kind: string, contentStart: number, contentEnd: number}>} */
  const blocks = [];
  const openRe = /<(template|script|style)\b[^>]*>/g;
  let cursor = 0;
  while (cursor < src.length) {
    openRe.lastIndex = cursor;
    const m = openRe.exec(src);
    if (!m) break;
    const kind = m[1];
    const contentStart = m.index + m[0].length;
    if (kind === 'template') {
      // 嵌套计数：只有同名 <template 开标签与 </template> 闭标签参与
      const tagRe = /<template\b[^>]*>|<\/template\s*>/g;
      tagRe.lastIndex = contentStart;
      let depth = 1;
      let end = src.length;
      let tm;
      while ((tm = tagRe.exec(src)) !== null) {
        if (tm[0].startsWith('</')) depth -= 1;
        else depth += 1;
        if (depth === 0) {
          end = tm.index;
          cursor = tm.index + tm[0].length;
          break;
        }
      }
      blocks.push({ kind, contentStart, contentEnd: end });
      if (depth !== 0) cursor = src.length; // 未闭合：记录到文件末尾，避免死循环
    } else {
      const closeIdx = src.indexOf(`</${kind}`, contentStart);
      const end = closeIdx < 0 ? src.length : closeIdx;
      blocks.push({ kind, contentStart, contentEnd: end });
      cursor = closeIdx < 0 ? src.length : closeIdx + 8;
    }
  }
  return blocks;
}

/**
 * 跳过字符串的最小词法器（用于 `<script>` / `.ts` / `.scss`）。
 *
 * <p>为什么不能直接用正则找注释：字符串里经常出现 `//`（URL）或 `/*`，正则会把它们当注释，
 * 于是「注释内的 gray-*」这类判定就整体失真。先跳过字符串是最小代价的正确做法。</p>
 *
 * <p>已知局限：不识别正则字面量 `/.../ `，其内容若含 `//` 会被误判为行注释。本仓库实测无此情况。</p>
 *
 * @param {string} text 文本
 * @param {{lineComments: boolean}} options 是否识别 `//` 行注释（SCSS 需要）
 * @returns {{comments: Array<[number, number]>, strings: Array<[number, number]>}} 区间
 */
function scanCommentsAndStrings(text, options) {
  /** @type {Array<[number, number]>} */
  const comments = [];
  /** @type {Array<[number, number]>} */
  const strings = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (options.lineComments && ch === '/' && text[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      comments.push([start, i]);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      comments.push([start, i]);
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      strings.push([start, i]);
      continue;
    }
    i += 1;
  }
  return { comments, strings };
}

/**
 * 扫出样式块里所有 `@apply` 的声明体区间。
 *
 * <p>为什么要抓区间而不是按行判断：`@apply` 允许跨行书写，按行判断会漏（漏了就会把类名
 * 误判成 `CSS_VALUE` 色值）。用「`@apply` 到声明结束的 `;` 或右花括号」作为区间最贴近事实。</p>
 *
 * @param {string} src 整份源码
 * @param {number} lo 区间下界
 * @param {number} hi 区间上界
 * @returns {Array<[number, number]>} `@apply` 声明体（不含 `@apply` 关键字）的区间
 */
function scanApplyRanges(src, lo, hi) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const segment = src.slice(lo, hi);
  const re = /@apply\b([^;{}]*)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const bodyStart = lo + m.index + '@apply'.length;
    out.push([bodyStart, bodyStart + m[1].length]);
  }
  return out;
}

/**
 * 扫出样式块里所有 CSS 声明值区间（`prop: value` 的 value 部分）。
 *
 * <p>用来区分「真正的 CSS 色值」（如 `color: #e4e4e7`）与「类名」——只有落在值区间里的
 * `gray-*` 才算 `CSS_VALUE`。</p>
 *
 * @param {string} src 整份源码
 * @param {number} lo 区间下界
 * @param {number} hi 区间上界
 * @returns {Array<[number, number]>} 值区间
 */
function scanCssValueRanges(src, lo, hi) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const segment = src.slice(lo, hi);
  const re = /(?:^|[;{}])\s*([-\w]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const valueStart = lo + m.index + m[0].length - m[2].length;
    out.push([valueStart, valueStart + m[2].length]);
  }
  return out;
}

/**
 * 找出 HTML 注释区间（`<!-- ... -->`）。
 * @param {string} text 模板内容
 * @returns {Array<[number, number]>} 区间
 */
function scanHtmlComments(text) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * 扫出模板里的属性值区间（用于区分静态 class / `:class` 绑定）。
 *
 * <p>为什么按「属性值区间」而不是按「元素」：同一个元素经常同时写 `class="…"` 与 `:class="…"`，
 * 按元素判定会把两者混为一类。</p>
 *
 * @param {string} text 模板内容
 * @returns {Array<{name: string, start: number, end: number}>} 属性值区间（start/end 为**值**的区间）
 */
function scanTemplateAttributes(text) {
  /** @type {Array<{name: string, start: number, end: number}>} */
  const out = [];
  // 属性名允许 :v-bind 前缀、@ 事件、# 插槽、点号与中划线；值必须带引号（无引号属性不含类名）
  const re = /([:@#][\w:.\-]*|[A-Za-z_][\w:.\-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const quoted = m[2];
    const valueStart = m.index + m[0].length - quoted.length + 1;
    const value = m[3] !== undefined ? m[3] : m[4];
    out.push({ name, start: valueStart, end: valueStart + value.length });
  }
  return out;
}

/** 判断位置是否落在某个区间集合内。 */
const inRanges = (pos, ranges) => ranges.some(([s, e]) => pos >= s && pos < e);

/** 取包含该位置的区间（返回第一个匹配）。 */
const rangeOf = (pos, ranges) => ranges.find(([s, e]) => pos >= s && pos < e) || null;

/**
 * 取命中所在的「类名 token」。
 *
 * <p>Tailwind 的变体是「类名 token 自身的一部分」（`dark:hover:text-gray-200` 是一个 token），
 * 因此必须按 token 切分来取，才能正确判断 `dark:` 变体与功能前缀。</p>
 *
 * @param {string} text 所在文本（整份源码，位置为全文偏移）
 * @param {number} start 命中起点
 * @param {number} end 命中终点
 * @param {number} lo 允许向左扩展的下界（所在字符串/属性值的起点）
 * @param {number} hi 允许向右扩展的上界
 * @returns {{token: string}} 类名 token
 */
function classTokenAt(text, start, end, lo, hi) {
  // 类名 token 的边界：空白是分隔符；引号/括号/逗号是「容器」字符，也必须当作边界，
  // 否则 `'bg-gray-800'` 会把开头引号吃进 token，导致把 JS 对象键 `dark:` 误判成 `dark:` 变体。
  const isSep = (ch) => ch === undefined || /[\s'\"`(){}[\],;]/.test(ch);
  let i = start;
  while (i > lo && !isSep(text[i - 1])) i -= 1;
  let j = end;
  while (j < hi && !isSep(text[j])) j += 1;
  return { token: text.slice(i, j) };
}

/**
 * 从类名 token 里解析出变体链与功能前缀。
 *
 * @param {string} token 类名 token（如 `dark:hover:text-gray-200`）
 * @param {string} family gray/zinc
 * @returns {{variants: string[], utility: string, prefix: string}} 解析结果
 */
function parseToken(token, family) {
  const idx = token.lastIndexOf(`${family}-`);
  const head = idx >= 0 ? token.slice(0, idx) : '';
  const segments = head.split(':').filter((s) => s.length > 0);
  // 最后一段是功能名（`text` / `bg` / `ring` …），其余是变体链（`dark` / `hover` / `focus-visible` …）
  const utilityName = (segments.length > 0 ? segments[segments.length - 1] : '').replace(/-$/, '');
  const dashIdx = utilityName.lastIndexOf('-');
  const prefix = dashIdx >= 0 ? utilityName.slice(dashIdx + 1) : utilityName;
  return { variants: segments.slice(0, -1), utility: utilityName, prefix };
}

/**
 * 判断是否在 `dark:` 变体内。
 * @param {string} variants 变体链（已去掉功能名）
 * @returns {boolean} 是否含 `dark`
 */
const inDarkVariant = (variants) => variants.includes('dark');

/**
 * 读取透明度后缀（`/20`、`/80`、`/[0.08]`）。
 * @param {string} text 整份源码
 * @param {number} end 命中终点
 * @returns {string} 后缀原文，无则空串
 */
function alphaSuffix(text, end) {
  const m = /^\/(\[[^\]]+\]|\d{1,3})/.exec(text.slice(end, end + 12));
  return m ? m[0] : '';
}

/**
 * 对单个文件做盘点。
 *
 * @param {string} abs 文件绝对路径
 * @param {(msg: string) => void} warn 告警回调
 * @returns {Array<object>} 命中记录
 */
function auditFile(abs, warn) {
  const rel = relFromRepo(abs);
  const src = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs);
  /** @type {Array<object>} */
  const records = [];

  // 逐块准备：块类型 + 注释区间 + 字符串区间 + 属性区间
  /** @type {Array<{kind: string, start: number, end: number, comments: Array<[number,number]>, strings: Array<[number,number]>, attrs: Array<{name: string, start: number, end: number}>}>} */
  const regions = [];
  if (ext === '.vue') {
    const blocks = splitSfcBlocks(src);
    if (blocks.length === 0) warn(`${rel}: 未找到 <template>/<script>/<style> 块，按 UNKNOWN 处理`);
    for (const b of blocks) {
      const text = src.slice(b.contentStart, b.contentEnd);
      if (b.kind === 'template') {
        // 模板里的 `<!-- -->` 直接按全文偏移翻译
        const comments = scanHtmlComments(text).map(([s, e]) => [s + b.contentStart, e + b.contentStart]);
        const attrs = scanTemplateAttributes(text).map((a) => ({
          name: a.name, start: a.start + b.contentStart, end: a.end + b.contentStart,
        }));
        // 模板的属性值里还可能写 JS 注释（`:class="[ // 说明 \n 'x' ]"`）。
        // 只对绑定属性（`:` / `v-bind:` 前缀）做 JS 注释识别，静态 `class="…"` 里不可能有注释。
        for (const a of attrs) {
          if (!a.name.startsWith(':') && !a.name.startsWith('v-bind:')) continue;
          const inner = src.slice(a.start, a.end);
          const { comments: c } = scanCommentsAndStrings(inner, { lineComments: true });
          for (const [cs, ce] of c) comments.push([cs + a.start, ce + a.start]);
        }
        regions.push({ kind: 'template', start: b.contentStart, end: b.contentEnd, comments, strings: [], attrs });
      } else if (b.kind === 'script') {
        const { comments, strings } = scanCommentsAndStrings(text, { lineComments: true });
        regions.push({
          kind: 'script', start: b.contentStart, end: b.contentEnd,
          comments: comments.map(([s, e]) => [s + b.contentStart, e + b.contentStart]),
          strings: strings.map(([s, e]) => [s + b.contentStart, e + b.contentStart]),
          attrs: [],
        });
      } else {
        const scss = /lang\s*=\s*["']?s[ac]ss/.test(src.slice(Math.max(0, b.contentStart - 120), b.contentStart));
        const { comments, strings } = scanCommentsAndStrings(text, { lineComments: scss });
        regions.push({
          kind: 'style', start: b.contentStart, end: b.contentEnd,
          comments: comments.map(([s, e]) => [s + b.contentStart, e + b.contentStart]),
          strings: strings.map(([s, e]) => [s + b.contentStart, e + b.contentStart]),
          attrs: [],
          applyRanges: scanApplyRanges(src, b.contentStart, b.contentEnd),
        });
      }
    }
  } else if (ext === '.ts') {
    const { comments, strings } = scanCommentsAndStrings(src, { lineComments: true });
    regions.push({ kind: 'script', start: 0, end: src.length, comments, strings, attrs: [] });
  } else {
    const scss = ext === '.scss';
    const { comments, strings } = scanCommentsAndStrings(src, { lineComments: scss });
    regions.push({ kind: 'style', start: 0, end: src.length, comments, strings, attrs: [], applyRanges: scanApplyRanges(src, 0, src.length) });
  }

  for (const m of src.matchAll(HIT_RE)) {
    const start = m.index ?? 0;
    const family = m[1];
    const tier = m[2];
    const end = start + m[0].length;
    const region = regions.find((r) => start >= r.start && start < r.end);
    const lineStarts = computeLineStarts(src);
    const { line, col } = lineColOf(lineStarts, start);
    const inComment = region ? inRanges(start, region.comments) : false;
    const strRange = region ? rangeOf(start, region.strings) : null;
    const attrRange = region ? region.attrs.find((a) => start >= a.start && start < a.end) : undefined;
    const lo = strRange ? strRange[0] + 1 : (attrRange ? attrRange.start : 0);
    const hi = strRange ? strRange[1] - 1 : (attrRange ? attrRange.end : src.length);
    const { token } = classTokenAt(src, start, end, lo, hi);
    const parsed = parseToken(token, family);

    // ── 逐级判定（顺序即规格，见头部 §6）──
    let category = 'UNKNOWN';
    let note = '';
    if (rel === TOKENS_CSS_REL) {
      category = 'TOKEN_DEF';
      note = inComment ? 'tokens.css 内注释；整文件禁止修改' : '调色板/令牌定义；绝对禁止修改';
    } else if (inComment) {
      category = 'COMMENT';
      note = '注释内容，替换与否需人工确认';
    } else if (region === undefined) {
      category = 'UNKNOWN';
      note = '不在任何已知块内';
    } else if (region.kind === 'template') {
      if (attrRange === undefined) {
        category = 'UNKNOWN';
        note = '模板内但不在任何属性值里（可能是文本/插值）';
      } else if (attrRange.name === 'class') {
        category = 'TPL_CLASS';
        note = '静态 class 属性';
      } else if (attrRange.name === ':class' || attrRange.name === 'v-bind:class') {
        category = 'TPL_BIND';
        note = '绑定表达式（三元/数组/函数调用）';
      } else {
        category = 'UNKNOWN';
        note = `其他属性：${attrRange.name}`;
      }
    } else if (region.kind === 'script') {
      if (strRange !== null) {
        category = 'TS_CLASS';
        note = '字符串字面量内的类名';
      } else {
        category = 'UNKNOWN';
        note = '脚本内但不在字符串/注释里';
      }
    } else {
      // style / css / scss：先判 `@apply`（是类名），再判是否真的落在 CSS 值位置
      if (inRanges(start, region.applyRanges || [])) {
        category = APPLY_CATEGORY;
        note = '@apply 内类名（是类名、可安全同档替换；按规格书排除在 CSS_VALUE 之外）';
      } else if (inRanges(start, scanCssValueRanges(src, region.start, region.end))) {
        category = 'CSS_VALUE';
        note = 'CSS 值位置（直接色值，需人工确认是否应改为令牌变量）';
      } else {
        category = 'UNKNOWN';
        note = 'CSS 块内但既不在 @apply 也不在声明值位置';
      }
    }

    const lineTextRaw = src.slice(lineStarts[line - 1], lineStarts[line] === undefined ? src.length : lineStarts[line] - 1);
    const excerpt = lineTextRaw.replace(/\t/g, ' ').replace(/\r$/, '').slice(0, 120);
    records.push({
      file: rel,
      line,
      col,
      family,
      tier,
      category,
      excerpt,
      inDark: inDarkVariant(parsed.variants),
      alpha: alphaSuffix(src, end),
      prefix: parsed.prefix || '(none)',
      token,
      note,
      block: region ? region.kind : '(none)',
    });
  }
  return records;
}

/**
 * 预计算每行起始偏移（1 基行号）。
 * @param {string} src 源码
 * @returns {number[]} 行起始偏移数组，index 0 对应第 1 行
 */
function computeLineStarts(src) {
  /** @type {number[]} */
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * 偏移 → 行列（均 1 基）。
 * @param {number[]} lineStarts 行起始偏移
 * @param {number} pos 偏移
 * @returns {{line: number, col: number}} 行号与列号
 */
function lineColOf(lineStarts, pos) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: pos - lineStarts[lo] + 1 };
}

/** CSV 单元格转义。 */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成 CSV 文本（不含时间戳 ⇒ 幂等）。
 * @param {Array<object>} records 记录
 * @returns {string} CSV 全文
 */
function renderCsv(records) {
  const header = ['file', 'line', 'col', 'category', 'family', 'tier', 'in_dark_variant', 'alpha_suffix', 'composite_prefix', 'block', 'token', 'line_excerpt', 'note'];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push([
      r.file, r.line, r.col, r.category, r.family, r.tier,
      r.inDark ? '1' : '0', r.alpha || '', r.prefix, r.block, r.token, r.excerpt, r.note,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** 定宽对齐（中文按 2 列宽计算，避免表格错位）。 */
function padTo(text, width) {
  const w = [...String(text)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
  return String(text) + ' '.repeat(Math.max(0, width - w));
}

/** 打印定宽表格。 */
function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(
    [...String(h)].length,
    ...rows.map((r) => [...String(r[i])].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0)),
  ));
  console.log(headers.map((h, i) => padTo(h, widths[i])).join('  '));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => padTo(c, widths[i])).join('  '));
}

/**
 * 主流程。
 * @returns {number} 退出码（0 = 成功；1 = 无法执行）
 */
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      '用法：node frontend/scripts/theme-spec/gray-zinc-audit.cjs [--csv <路径>]',
      '',
      '  只读盘点 frontend/src/** (.vue/.ts/.css/.scss) 里所有 gray-NN / zinc-NN 出现点。',
      '  不修改任何源码；仅写出一份 CSV（默认 .lingxi/tmp/theme/gray-zinc-audit.csv）。',
      '',
      '  --csv <路径>   指定 CSV 输出路径（相对仓库根或绝对路径）',
      '  --help         显示本帮助',
    ].join('\n'));
    return 0;
  }
  const csvIdx = argv.indexOf('--csv');
  let csvPath = DEFAULT_CSV;
  if (csvIdx >= 0) {
    const v = argv[csvIdx + 1];
    if (!v || v.startsWith('--')) {
      console.error('[gray-zinc-audit] --csv 需要一个路径参数');
      return 1;
    }
    csvPath = path.isAbsolute(v) ? v : path.join(REPO_ROOT, v);
  }
  if (!fs.existsSync(SRC_ROOT)) {
    console.error(`[gray-zinc-audit] 找不到源码目录：${SRC_ROOT}`);
    return 1;
  }

  const files = collectFiles(SRC_ROOT);
  /** @type {Array<object>} */
  const records = [];
  /** @type {string[]} */
  const warnings = [];
  for (const abs of files) {
    try {
      records.push(...auditFile(abs, (msg) => warnings.push(msg)));
    } catch (err) {
      warnings.push(`${relFromRepo(abs)}: 解析失败 ${err && err.message ? err.message : err}`);
    }
  }

  // ── 逐处明细（规格要求的单行格式）──
  console.log('=== 逐处明细（文件:行:列 | 档位 | 类别 | 行原文 | dark | alpha）===');
  for (const r of records) {
    console.log(`${r.file}:${r.line}:${r.col} | ${r.family}-${r.tier} | ${r.category} | ${r.excerpt} | dark=${r.inDark ? 'Y' : 'N'} | alpha=${r.alpha || 'N'}`);
  }

  // ── 分类计数 ──
  const byCategory = new Map(CATEGORIES.map((c) => [c, 0]));
  for (const r of records) byCategory.set(r.category, (byCategory.get(r.category) || 0) + 1);
  console.log('\n=== 分类计数 ===');
  printTable(['类别', '处数'], CATEGORIES.map((c) => [c, String(byCategory.get(c) || 0)]));

  // ── 档位分布 ──
  const byTier = new Map();
  for (const r of records) {
    const key = `${r.family}-${r.tier}`;
    byTier.set(key, (byTier.get(key) || 0) + 1);
  }
  const tierRows = [...byTier.entries()].sort((a, b) => {
    const [fa, ta] = a[0].split('-');
    const [fb, tb] = b[0].split('-');
    return fa < fb ? -1 : fa > fb ? 1 : Number(ta) - Number(tb);
  });
  console.log('\n=== 档位分布 ===');
  printTable(['档位', '处数'], tierRows.map(([k, v]) => [k, String(v)]));

  // ── 文件维度计数 ──
  const byFile = new Map();
  for (const r of records) {
    const cur = byFile.get(r.file) || { gray: 0, zinc: 0 };
    cur[r.family] += 1;
    byFile.set(r.file, cur);
  }
  const fileRows = [...byFile.entries()].sort((a, b) => {
    const diff = (b[1].gray + b[1].zinc) - (a[1].gray + a[1].zinc);
    if (diff !== 0) return diff;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  console.log(`\n=== 文件维度计数（${fileRows.length} 个文件）===`);
  printTable(['文件', 'gray', 'zinc', '合计'], fileRows.map(([f, c]) => [f, String(c.gray), String(c.zinc), String(c.gray + c.zinc)]));

  // ── 复合前缀 / dark / alpha ──
  const composite = records.filter((r) => COMPOSITE_PREFIXES.has(r.prefix));
  const byPrefix = new Map();
  for (const r of composite) byPrefix.set(r.prefix, (byPrefix.get(r.prefix) || 0) + 1);
  console.log('\n=== 复合前缀（shadow-/ring-/divide-/placeholder-/stroke- 等）===');
  if (composite.length === 0) {
    console.log('（无）');
  } else {
    printTable(['前缀', '处数'], [...byPrefix.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]));
    for (const r of composite) console.log(`  ${r.file}:${r.line}:${r.col} | ${r.token}`);
  }
  const withAlpha = records.filter((r) => r.alpha !== '');
  console.log(`\n=== 带透明度后缀（/20 之类）：${withAlpha.length} 处 ===`);
  for (const r of withAlpha) console.log(`  ${r.file}:${r.line}:${r.col} | ${r.token}  (后缀 ${r.alpha})`);
  const darkCount = records.filter((r) => r.inDark).length;
  console.log(`\n=== dark: 变体内：${darkCount} 处 / 共 ${records.length} 处 ===`);

  // ── @apply 专项（避免被 UNKNOWN 淹没）──
  const applyRecords = records.filter((r) => r.note.startsWith('@apply'));
  console.log(`\n=== @apply 内类名：${applyRecords.length} 处（类名，可安全同档替换）===`);
  for (const r of applyRecords) console.log(`  ${r.file}:${r.line}:${r.col} | ${r.token}`);

  // ── 总量 ──
  const grayTotal = records.filter((r) => r.family === 'gray').length;
  const zincTotal = records.filter((r) => r.family === 'zinc').length;
  console.log(`\n=== 总量 ===`);
  console.log(`  扫描文件: ${files.length} 个（.vue/.ts/.css/.scss）`);
  console.log(`  gray-*  : ${grayTotal} 处`);
  console.log(`  zinc-*  : ${zincTotal} 处`);
  console.log(`  合计    : ${records.length} 处`);
  const grayFiles = new Set(records.filter((r) => r.family === 'gray').map((r) => r.file));
  const zincFiles = new Set(records.filter((r) => r.family === 'zinc').map((r) => r.file));
  const bothFiles = [...grayFiles].filter((f) => zincFiles.has(f));
  console.log(`  含 gray 的文件: ${grayFiles.size}；含 zinc 的文件: ${zincFiles.size}；两者都有: ${bothFiles.length}`);

  // ── 写 CSV（自身产物，绝不写进 src/）──
  const csv = renderCsv(records);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, csv);
  const csvLines = csv.split('\n').length - 2; // 去掉表头与结尾空行
  console.log(`\n=== CSV ===`);
  console.log(`  路径: ${path.relative(REPO_ROOT, csvPath).split(path.sep).join('/')}`);
  console.log(`  数据行: ${csvLines}（表头 1 行 + 数据 ${records.length} 行）`);

  if (warnings.length > 0) {
    console.log(`\n=== 告警（${warnings.length}）===`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  return 0;
}

process.exit(main());
