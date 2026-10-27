#!/usr/bin/env node
/**
 * 主题令牌颜色解析器 —— M3 等价门禁的底座（不要绕过它直接比 CSS 字符串）。
 *
 * 为什么需要它：
 *   组件里的 `isDark ? 'text-zinc-200' : 'text-gray-900'` 这种写法，肉眼判断「换成
 *   `text-lx-primary` 之后有没有变色」是不可能的。必须把类名解析成**真实取值**再比。
 *   真实取值只有两个来源：Tailwind v4 的构建产物（oklch / 8 位 hex）和 tokens.css（令牌定义）。
 *
 * 数据链路（缺一环就会误判）：
 *   组件类名 → dist 产物里的规则（`.text-lx-primary{color:var(--color-lx-primary)}`）
 *            → style.css 的 `@theme inline` 桥（`--color-lx-primary: var(--lx-text-primary)`）
 *            → tokens.css 的 `--lx-text-primary: #ffffff`（暗）/ `#101828`（亮）
 *
 * 三条硬结论（实测得来，别再重踩）：
 *   1) **alpha 必须参与判等**：曾丢掉 alpha，导致 `bg-white/10` 与纯白被判相等（假等价）。
 *      归一化输出 `#rrggbb@0.102`。
 *   2) **产物必须合并全部 chunk**：vite 按 chunk 拆 CSS，懒加载组件的类只出现在
 *      `ChatView-*.css` 之类的独立文件里；只读 `main-*.css` 会整片盲区，
 *      表现为「源码明明在用、产物里查不到」——那是盲区，不是类名写错。
 *   3) **不得用 hex 判等**判「令牌值 == 类名实际色」：v4 调色板 + oklch→hex 往返
 *      在高饱和色上差到 8/255，所以比较必须带容差（见 check-theme-equivalence.mjs 的 TOL）。
 *
 * 用法（也可被 check-theme-equivalence.mjs 作为库 import）：
 *   node scripts/check-theme-colors.mjs                    # 自检（默认动作）
 *   node scripts/check-theme-colors.mjs --selftest         # 同上
 *   node scripts/check-theme-colors.mjs --class bg-white/10 --mode dark
 *   node scripts/check-theme-colors.mjs --report           # 产物规模/tokens 规模
 *
 * 自检的意义：解析器自身写错会产出「假绿」——门禁永远绿、实际已在漂移。
 * 因此内置已知 Tailwind 色值断言 + 与 Tailwind 自带 8 位 hex 的交叉校验，跑通才算可信。
 *
 * 前置：`npm run build`（或 `npx vite build`）产出 frontend/dist/assets/*.css。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录 = frontend/scripts —— 一切路径从它自解析，不依赖 cwd、不依赖仓库外目录 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** frontend/ 根目录 */
export const FRONTEND_ROOT = path.resolve(__dirname, '..');
/** 构建产物的 CSS 目录（vite build 产出，.gitignore 忽略） */
export const DIST_ASSETS_DIR = path.join(FRONTEND_ROOT, 'dist', 'assets');
/** 令牌定义（暗/亮双套） */
export const TOKENS_CSS = path.join(FRONTEND_ROOT, 'src', 'theme', 'tokens.css');
/** Tailwind 入口：@theme inline 桥接层在这里 */
export const STYLE_CSS = path.join(FRONTEND_ROOT, 'src', 'style.css');

// ---------------------------------------------------------------------------
// 1. 颜色归一化：任意 CSS 颜色 → '#rrggbb' 或 '#rrggbb@0.123'
// ---------------------------------------------------------------------------

/**
 * sRGB 传输函数（线性光 → 8bit 编码）。
 * @param {number} c 线性分量，可为负（色域外）
 * @returns {number} 编码后的分量
 */
const sRGB = (c) => {
  const a = Math.abs(c);
  const v = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return Math.sign(c) * v;
};

/**
 * oklch → sRGB（线性到编码）。Tailwind v4 调色板全部以 oklch 定义，必须自己反算。
 * @param {number} L 亮度 0..1
 * @param {number} C 彩度
 * @param {number} hDeg 色相角（度）
 * @returns {[number, number, number]} 0..1 区间（可能略越界，由调用方 clamp）
 */
const oklchToRgb = (L, C, hDeg) => {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [sRGB(r), sRGB(g), sRGB(bb)];
};

/**
 * 0..1 分量 → 两位 hex。
 * @param {number} x 分量
 * @returns {string} 两位 hex
 */
const hex2 = (x) => {
  const n = Math.round(Math.min(1, Math.max(0, x)) * 255);
  return n.toString(16).padStart(2, '0');
};

/**
 * 任意 CSS 颜色值 → 归一化字符串。不透明返回 `#rrggbb`，带 alpha 返回 `#rrggbb@0.123`。
 *
 * ⚠️ alpha 必须保留：把 `bg-white/10` 与不透明白判成相等会造成假等价（历史缺陷）。
 * ⚠️ 无法识别的值（`8px`、`0 1px 2px var(...)` 等非颜色）返回 null，由调用方决定如何处置；
 *    不得静默当成「相等」。
 *
 * @param {unknown} raw CSS 颜色原串
 * @returns {string | null} 归一化颜色，或 null（不是颜色）
 */
export const normalizeColor = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null;
  const v = raw.trim().toLowerCase();

  // 色相允许 `none`：Tailwind v4 的灰阶（如 `--color-zinc-50: oklch(98.5% 0 none)`）彩度为 0，
  // 色相角无意义，规范允许写 `none`。旧正则只认 `[\d.]+`，遇到 `none` 整条匹配失败 ⇒
  // normalizeColor 返回 null ⇒ 该类被当作「无法解析」丢进 raw，**整族灰阶永远不进 residual 统计**
  // （G-7：实测 zinc-50 全族 41 项计量失明）。C=0 时色相取任何值结果相同，故把 none 当 0。
  const oklch = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+%?|none)\s+([\d.]+|none)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/);
  if (oklch) {
    const lRaw = Number(oklch[1]);
    const L = oklch[2] === '%' || lRaw > 1 ? lRaw / 100 : lRaw;
    const cRaw = oklch[3] === 'none' ? 0 : Number(String(oklch[3]).replace('%', ''));
    const C = String(oklch[3]).endsWith('%') ? cRaw / 100 : cRaw;
    const hueDeg = oklch[4] === 'none' ? 0 : Number(oklch[4]);
    const [r, g, b] = oklchToRgb(L, C, hueDeg);
    const alpha = oklch[5] === undefined
      ? 1
      : (oklch[6] === '%' ? Number(oklch[5]) / 100 : Number(oklch[5]));
    return '#'.concat(hex2(r), hex2(g), hex2(b), alpha >= 1 ? '' : '@' + alpha.toFixed(3));
  }

  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('') + 'ff';
    else if (h.length === 4) h = h.split('').map((c) => c + c).join('');
    else if (h.length === 6) h = h + 'ff';
    if (h.length !== 8) return null;
    const a = parseInt(h.slice(6, 8), 16) / 255;
    const rgb = '#' + h.slice(0, 6);
    return a >= 1 ? rgb : rgb + '@' + a.toFixed(3);
  }

  const rgb = v.match(/^rgba?\(\s*([\d.]+)(%?)[ ,]+([\d.]+)(%?)[ ,]+([\d.]+)(%?)(?:[ ,/]+([\d.]+)(%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[7] === undefined
      ? 1
      : (rgb[8] === '%' ? Number(rgb[7]) / 100 : Number(rgb[7]));
    const to255 = (val, pct) => (pct === '%' ? (Number(val) / 100) * 255 : Number(val));
    const base = '#'.concat(
      hex2(to255(rgb[1], rgb[2]) / 255),
      hex2(to255(rgb[3], rgb[4]) / 255),
      hex2(to255(rgb[5], rgb[6]) / 255)
    );
    return alpha >= 1 ? base : base + '@' + alpha.toFixed(3);
  }

  const named = v.match(/^(transparent|white|black)$/);
  if (named) {
    if (named[1] === 'transparent') return '#000000@0.000';
    return named[1] === 'white' ? '#ffffff' : '#000000';
  }

  return null;
};

/**
 * 归一化颜色串 → 数值 RGBA。
 * @param {unknown} s `#rrggbb` 或 `#rrggbb@a`
 * @returns {{r: number, g: number, b: number, a: number} | null} 数值，或 null（非归一化格式）
 */
export const parseRgba = (s) => {
  if (typeof s !== 'string') return null;
  const m = s.match(/^#([0-9a-f]{6})(?:@([\d.]+))?$/);
  if (!m) return null;
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
    a: m[2] === undefined ? 1 : Number(m[2])
  };
};

// ---------------------------------------------------------------------------
// 2. 构建产物解析：类名 → (CSS 属性, 真实取值)
// ---------------------------------------------------------------------------

/**
 * 列出产物 CSS 文件（**全部 chunk**，不只看 main-*）。
 * @param {string} cssPathOrDir CSS 目录或单文件
 * @returns {string[]} 绝对路径列表
 */
const listCssFiles = (cssPathOrDir) => {
  const stat = fs.statSync(cssPathOrDir);
  if (!stat.isDirectory()) return [cssPathOrDir];
  return fs
    .readdirSync(cssPathOrDir)
    .filter((f) => f.endsWith('.css') && !f.endsWith('.map'))
    .sort()
    .map((f) => path.join(cssPathOrDir, f));
};

/** 产物里只取颜色相关的 `--color-*` 变量表 */
const COLOR_VAR_RE = /--(color-[a-z0-9-]+)\s*:\s*([^;}]+)/g;
/**
 * 工具类规则：`.cls{p看:值}`。
 * cls 需容忍 `\:`、`\/`、`\[`、`\]`、`\.` 这类转义（hover:/bg-white/10/w-[3px]）。
 * 伪类后缀（`::placeholder`、`:hover`）一并收下。
 */
const UTIL_RE = /\.((?:\\[:/.[\]]|[A-Za-z0-9-])+)((?:::?[a-z-]+)*)\{([a-z-]+):(var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|oklch\([^)]*\))\}/g;

/**
 * 读构建产物（**必须是整个 dist/assets 目录**，理由见文件头结论 2）。
 *
 * @param {string} cssPathOrDir CSS 目录或单文件
 * @returns {{vars: Map<string,string>, classes: Map<string,{prop: string, raw: string, value: string|null, file: string, pseudo: string}>, files: string[], filePaths: string[]}}
 * @throws {Error} 路径不存在或无 CSS 文件时抛出（产物缺失必须显式报错，不能静默返回空表导致假绿）
 */
export const loadBuiltCss = (cssPathOrDir) => {
  if (!fs.existsSync(cssPathOrDir)) {
    throw new Error(`构建产物不存在：${cssPathOrDir}（请先执行 npm run build / npx vite build）`);
  }
  const filePaths = listCssFiles(cssPathOrDir);
  if (filePaths.length === 0) {
    throw new Error(`${cssPathOrDir} 下没有任何 .css 产物（请先执行 npm run build / npx vite build）`);
  }
  const vars = new Map();
  const classes = new Map();
  for (const file of filePaths) {
    const css = fs.readFileSync(file, 'utf8');
    for (const m of css.matchAll(COLOR_VAR_RE)) {
      if (!vars.has(m[1])) vars.set(m[1], m[2].trim());
    }
    for (const m of css.matchAll(UTIL_RE)) {
      const cls = m[1].replace(/\\(.)/g, '$1');
      if (classes.has(cls)) continue;
      classes.set(cls, {
        prop: m[3],
        raw: m[4],
        value: resolveValue(m[4], vars),
        file: path.basename(file),
        pseudo: m[2]
      });
    }
  }
  return { vars, classes, files: filePaths.map((f) => path.basename(f)), filePaths };
};

/**
 * 产物里的字面值 → 归一化颜色（`var(--color-x)` 需要先查变量表）。
 * @param {string} raw 声明的值
 * @param {Map<string,string>} vars `--color-*` 变量表
 * @returns {string | null} 归一化颜色，或 null
 */
const resolveValue = (raw, vars) => {
  const varName = raw.match(/^var\(--([a-z0-9-]+)\)$/);
  if (varName) return normalizeColor(vars.get(varName[1]) ?? '');
  return normalizeColor(raw);
};

// ---------------------------------------------------------------------------
// 3. 令牌定义解析：tokens.css 双套 + style.css 桥接层
// ---------------------------------------------------------------------------

/**
 * 解析 tokens.css 的两套令牌取值。
 * 暗色 = `:root`（应用默认暗色，避免首帧闪烁）；亮色 = `html.light` / `html[data-theme="light"]`。
 *
 * @param {string} tokensCssPath tokens.css 绝对路径
 * @returns {{dark: Record<string,string>, light: Record<string,string>}}
 */
export const loadTokens = (tokensCssPath) =>
  loadTokensFromText(String(fs.readFileSync(tokensCssPath, 'utf8')));

/**
 * 同 loadTokens，但入参是 CSS 文本而非路径。
 * 门禁需要用它解析「基线版本的令牌表」——否则两侧都用当前令牌表，
 * 令牌取值被改错时两侧一起变，漂移会被静默吞掉。
 *
 * @param {string} text tokens.css 的内容
 * @returns {{dark: Record<string,string>, light: Record<string,string>}}
 */
export const loadTokensFromText = (text) => {
  const css = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  const darkBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const lightBlock = css.match(/html\.light[^{]*\{([\s\S]*?)\}/)?.[1] ?? '';
  /** @param {string} block CSS 块 */
  const parse = (block) => {
    /** @type {Record<string,string>} */
    const out = {};
    for (const m of block.matchAll(/(--lx-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  return { dark: parse(darkBlock), light: parse(lightBlock) };
};

/**
 * 解析 `@theme inline` 桥接层：工具类变量 → 令牌变量。
 * 少这一层会把所有令牌类判成「不可解析」（历史坑）。
 *
 * @param {string} styleCssPath style.css 绝对路径
 * @returns {Map<string,string>} `color-lx-primary` → `lx-text-primary`（键不带 `--`）
 */
export const loadThemeMap = (styleCssPath) => {
  const map = new Map();
  if (!fs.existsSync(styleCssPath)) return map;
  return loadThemeMapFromText(String(fs.readFileSync(styleCssPath, 'utf8')));
};

/**
 * 同 loadThemeMap，但入参是 CSS 文本而非路径（门禁取基线版本用）。
 *
 * @param {string} text style.css 的内容
 * @returns {Map<string,string>} `color-lx-primary` → `lx-text-primary`（键不带 `--`）
 */
export const loadThemeMapFromText = (text) => {
  const map = new Map();
  const css = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
  const block = css.match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*var\(--([a-z0-9-]+)\)\s*;/g)) map.set(m[1], m[2]);
  return map;
};

/**
 * 一次性装配解析上下文（产物 + 令牌两套 + 桥接层）。
 *
 * @param {string} [frontendRoot] frontend 根目录，默认本文件推得
 * @param {string} [distDir] 产物目录，默认 `<frontendRoot>/dist/assets`
 * @returns {{built: ReturnType<typeof loadBuiltCss>, tokens: ReturnType<typeof loadTokens>, themeMap: Map<string,string>, distDir: string}}
 */
export const loadThemeContext = (frontendRoot = FRONTEND_ROOT, distDir = '') => {
  const root = path.resolve(frontendRoot);
  const resolvedDist = distDir === '' ? path.join(root, 'dist', 'assets') : path.resolve(distDir);
  return {
    built: loadBuiltCss(resolvedDist),
    tokens: loadTokens(path.join(root, 'src', 'theme', 'tokens.css')),
    themeMap: loadThemeMap(path.join(root, 'src', 'style.css')),
    distDir: resolvedDist
  };
};

// ---------------------------------------------------------------------------
// 4. 类名解析：类名 + 明暗模式 → (属性, 真实取值)
// ---------------------------------------------------------------------------

/** 门禁关心的「颜色类属性」白名单（非颜色属性不参与颜色判等） */
export const COLOR_PROPS = new Set([
  'color', 'background-color', 'border-color', 'border-top-color', 'border-bottom-color',
  '--tw-ring-color', 'fill', 'stroke', 'outline-color', 'text-decoration-color', 'caret-color', 'accent-color',
  '--tw-gradient-from', '--tw-gradient-to', '--tw-gradient-via'
]);

/**
 * 把工具类解析成「这条类在指定模式下真实的颜色取值」。
 *
 * 解析顺序（顺序不能变）：
 *   1. `var(--color-lx-*)` → 先过 `@theme inline` 桥 → 查 tokens.css 对应模式；
 *   2. `var(--lx-*)` → 直接查 tokens.css；
 *   3. `var(--color-*)` → 查产物变量表（Tailwind 调色板）；
 *   4. `color-mix(in oklab, var(--color-x) N%, transparent)` → 按 N% 展开成 alpha；
 *   5. 其他字面值（hex/rgba/oklch）→ 直接归一化。
 *
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @param {string} cls 工具类名（不带前导点）
 * @param {'dark'|'light'} mode 明暗模式
 * @returns {{prop: string, value: string} | null} 解析结果；null = 产物里没有这条规则（类名可能写错）
 */
export const resolveClass = (ctx, cls, mode) => {
  if (typeof cls !== 'string' || cls === '') return null;
  if (mode !== 'dark' && mode !== 'light') return null;
  const hit = ctx.built.classes.get(cls);
  if (!hit) return null;
  const raw = hit.raw;

  const ref = raw.match(/^var\(--([a-z0-9-]+)\)$/);
  if (ref) {
    const bridged = ctx.themeMap.get(ref[1]);
    if (bridged) {
      const v = ctx.tokens[mode]['--' + bridged];
      return v === undefined ? null : { prop: hit.prop, value: normalizeColor(v) };
    }
    if (ref[1].startsWith('lx-')) {
      const v = ctx.tokens[mode]['--' + ref[1]];
      return v === undefined ? null : { prop: hit.prop, value: normalizeColor(v) };
    }
    const v = ctx.built.vars.get(ref[1]);
    return v === undefined ? null : { prop: hit.prop, value: normalizeColor(v) };
  }

  const mix = raw.match(/^color-mix\(in oklab,\s*var\(--([a-z0-9-]+)\)\s*([\d.]+)%,\s*transparent\)$/i);
  if (mix) {
    const base = ctx.built.vars.get(mix[1]);
    if (base === undefined) return null;
    const c = parseRgba(normalizeColor(base));
    if (!c) return null;
    const a = Number(mix[2]) / 100;
    const rgb = '#'.concat(
      c.r.toString(16).padStart(2, '0'),
      c.g.toString(16).padStart(2, '0'),
      c.b.toString(16).padStart(2, '0')
    );
    return { prop: hit.prop, value: a >= 1 ? rgb : rgb + '@' + a.toFixed(3) };
  }

  const v = normalizeColor(raw);
  return v === null ? null : { prop: hit.prop, value: v };
};

// ---------------------------------------------------------------------------
// 5. 交叉校验（打破自证循环）
// ---------------------------------------------------------------------------

/**
 * 用 Tailwind **自己算出来的** 8 位 hex 交叉校验本解析器的 oklch→sRGB 实现。
 *
 * 思路：产物里对带透明度修饰的类会直接吐出预计算 hex，例如
 *   `.border-gray-200\/50{border-color:#e5e7eb80}`
 * 这个 hex 与手写 oklch 数学完全独立，比对它就能证明解析器没算错。
 *
 * @param {{built: ReturnType<typeof loadBuiltCss>}} ctx 上下文
 * @returns {{colors: number, mismatched: number, maxChannelDelta: number, rows: Array<{name: string, mine: string, emitted: string, d: number, ok: boolean, alphaOk: boolean}>}}
 */
export const crossCheckAlphaHex = (ctx) => {
  const css = ctx.built.filePaths.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const pairs = new Map();
  for (const m of css.matchAll(/\.((?:[a-z-]+)-([a-z]+-\d{2,3}))\\\/(\d{1,3})\{[a-z-]+:(#[0-9a-fA-F]{8})\}/g)) {
    const colorName = m[2];
    const alpha = Number(m[3]) / 100;
    const emitted = m[4].toLowerCase();
    const varRaw = ctx.built.vars.get('color-' + colorName);
    if (!varRaw) continue;
    const mine = normalizeColor(varRaw);
    if (!mine || !mine.startsWith('#')) continue;
    const wantAlpha = Math.round(alpha * 255);
    const emittedRgb = emitted.slice(0, 7);
    const emittedAlpha = parseInt(emitted.slice(7, 9), 16);
    let d = 0;
    for (let i = 1; i < 7; i += 2) {
      d = Math.max(d, Math.abs(parseInt(mine.slice(i, i + 2), 16) - parseInt(emittedRgb.slice(i, i + 2), 16)));
    }
    // 容差 8/255：Tailwind 对高饱和色（green-500 / amber-500 / sky-500）的 hex 化与
    // 本实现的 oklch→sRGB 最多差 8。这也说明「按 hex 判等」在高饱和色上不可靠，
    // 所以等价门禁一律走容差比较，不用字符串判等。
    const alphaOk = emittedAlpha === wantAlpha;
    pairs.set(colorName, { name: colorName, mine, emitted, d, alphaOk, ok: alphaOk && d <= 8 });
  }
  const rows = [...pairs.values()];
  const mismatched = rows.filter((r) => !r.ok).length;
  const maxChannelDelta = rows.reduce((acc, r) => (r.alphaOk ? Math.max(acc, r.d) : acc), 0);
  return { colors: rows.length, mismatched, maxChannelDelta, rows };
};

// ---------------------------------------------------------------------------
// 6. 自检 + CLI
// ---------------------------------------------------------------------------

/**
 * 自检：已知色值断言 + alpha 断言 + 交叉校验。
 * 自检不过 = 解析器不可信 = 门禁结论无效（可能假绿）。
 *
 * @returns {number} 0 = PASS，1 = FAIL
 */
const selftest = () => {
  let bad = 0;
  const check = (label, ok, extra = '') => {
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
    if (!ok) bad += 1;
  };

  let ctx;
  try {
    ctx = loadThemeContext();
  } catch (e) {
    console.error('FAIL  无法加载构建产物：' + e.message);
    console.error('      先执行 `npm run build`（或 `npx vite build`）再跑自检。');
    return 1;
  }

  console.log(
    '产物 chunk = ' + ctx.built.files.join(', ') +
    ' | color vars = ' + ctx.built.vars.size +
    ' | utility classes = ' + ctx.built.classes.size
  );

  // 期望值全部由产物 oklch 手工反算交叉校验得来；注意 v4 调色板 ≠ v3（blue-500 v4=#2b7fff）
  const expect = {
    'text-zinc-200': '#e4e4e7',
    'text-gray-700': '#364153',
    'bg-gray-100': '#f3f4f6',
    'text-gray-900': '#101828',
    'border-gray-200': '#e5e7eb',
    'text-blue-500': '#2b7fff',
    'text-cyan-400': '#00d3f2',
    'text-red-600': '#e7000b'
  };
  for (const [cls, want] of Object.entries(expect)) {
    const got = ctx.built.classes.get(cls)?.value;
    check('解析 ' + cls, got === want, 'got=' + got + ' want=' + want);
  }

  // alpha 必须参与判等，否则 bg-white/10 会被当成不透明白 → 假等价
  const alphaCases = { 'border-white/20': '#ffffff@0.200', 'bg-white/10': '#ffffff@0.102' };
  for (const [cls, want] of Object.entries(alphaCases)) {
    const got = ctx.built.classes.get(cls)?.value;
    check('alpha 参与判等 ' + cls, got === want, 'got=' + got + ' want=' + want);
  }
  check('纯白 ≠ 半透明白', normalizeColor('#ffffff') !== normalizeColor('#ffffff80'));

  // 伪类类名要能解析（否则 hover:/placeholder 会静默落进字面量层）
  const ph = resolveClass(ctx, 'placeholder-zinc-500', 'dark');
  check('伪类类名可解析 placeholder-zinc-500', ph !== null && ph.value === '#71717b', JSON.stringify(ph));

  // 令牌链路：桥接层 + tokens.css 双套都要通
  const canvas = resolveClass(ctx, 'bg-lx-canvas', 'dark');
  check('令牌链路 bg-lx-canvas（暗）', canvas !== null && canvas.value === '#000000', JSON.stringify(canvas));
  const canvasLight = resolveClass(ctx, 'bg-lx-canvas', 'light');
  check('令牌链路 bg-lx-canvas（亮）', canvasLight !== null && canvasLight.value === '#ffffff', JSON.stringify(canvasLight));
  const primary = resolveClass(ctx, 'text-lx-primary', 'dark');
  check('令牌链路 text-lx-primary（暗）', primary !== null && primary.value === '#ffffff', JSON.stringify(primary));

  // 写错的令牌名必须解析不到（Tailwind 不产出规则 = 等于没写，是静默失效）
  check('写错的令牌名解析不到', resolveClass(ctx, 'bg-lx-canvas-typo', 'dark') === null);
  check('不存在的类名解析不到', resolveClass(ctx, 'text-nope-123', 'dark') === null);

  // 交叉校验：与 Tailwind 自带 8 位 hex 对齐
  const cross = crossCheckAlphaHex(ctx);
  check(
    '交叉校验（' + cross.colors + ' 色，RGB 最大通道差 ' + cross.maxChannelDelta + '）',
    cross.mismatched === 0 && cross.colors > 0
  );

  console.log(bad === 0 ? '\nSELFTEST PASS' : '\nSELFTEST FAIL count=' + bad);
  return bad === 0 ? 0 : 1;
};

/**
 * 打印产物与令牌规模，便于人工核对。
 * @returns {number} 退出码
 */
const report = () => {
  let ctx;
  try {
    ctx = loadThemeContext();
  } catch (e) {
    console.error('FAIL  ' + e.message);
    return 1;
  }
  console.log('[check-theme-colors] 产物 chunk：' + ctx.built.files.join(', '));
  console.log('  utility classes : ' + ctx.built.classes.size);
  console.log('  color vars      : ' + ctx.built.vars.size);
  console.log('  桥接层条目      : ' + ctx.themeMap.size);
  console.log('  令牌 暗/亮      : ' + Object.keys(ctx.tokens.dark).length + ' / ' + Object.keys(ctx.tokens.light).length);
  return 0;
};

/** 入口判定：被 import 时不执行 CLI */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--selftest')) {
    process.exit(selftest());
  } else if (args.includes('--report')) {
    process.exit(report());
  } else if (args.includes('--class')) {
    const idx = args.indexOf('--class');
    const cls = args[idx + 1];
    if (!cls) {
      console.error('用法：--class <类名> [--mode dark|light]');
      process.exit(1);
    }
    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'dark';
    if (mode !== 'dark' && mode !== 'light') {
      console.error('--mode 只能是 dark 或 light');
      process.exit(1);
    }
    let ctx;
    try {
      ctx = loadThemeContext();
    } catch (e) {
      console.error('FAIL  ' + e.message);
      process.exit(1);
    }
    const hit = ctx.built.classes.get(cls);
    const resolved = resolveClass(ctx, cls, mode);
    console.log(JSON.stringify({ cls, mode, inProduct: Boolean(hit), prop: hit?.prop ?? null, value: resolved?.value ?? null }, null, 2));
    process.exit(resolved === null ? 2 : 0);
  } else {
    console.error('用法：node scripts/check-theme-colors.mjs [--selftest | --report | --class <类名> [--mode dark|light]]');
    process.exit(1);
  }
}
