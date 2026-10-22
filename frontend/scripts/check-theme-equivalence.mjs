#!/usr/bin/env node
/**
 * 主题令牌等价性门禁（M3 等价性验收的唯一机器判据）。
 *
 * ────────────────────────────────────────────────────────────────
 * 它到底在检查什么（三层，缺一层就会放过真实缺陷）
 * ────────────────────────────────────────────────────────────────
 * 第 1 层 · 静态可达性（**不需要 git，任何树都能跑，CI 里这一层才有意义**）
 *   源码里出现的每个令牌类（`bg-lx-*` / `text-lx-*` / `border-lx-*` …）必须在
 *   构建产物里能解析到真实取值。解析不到 = Tailwind 不产出规则 = **组件像没写**
 *   （静默失效）。写错一个字母就属于这一层，判死。
 *
 * 第 2 层 · 颜色等价（三元分支 vs 三元分支，按数值 RGBA 带容差比）
 *   `isDark ? 'text-zinc-400' : 'text-gray-500'` 换成令牌后，暗/亮两侧的真实取值
 *   必须分别与改造前相等。容差写在 TOL 里可审计：
 *     RGB 每通道 ≤ 8（v4 调色板 hex 化 + oklch 反算的实测最大差）
 *     alpha ≤ 0.01（8 位量化误差）
 *
 * 第 3 层 · 非颜色类字面量（多重集严格比）
 *   非颜色类（`flex` / `mb-2.5` / `text-[10px]`）一变就是行为变更，不做容差，直接报。
 *
 * ────────────────────────────────────────────────────────────────
 * 第 4 层 · 令牌数值（`--check-token-values`，**不需要 git 基线**）
 *   第 1~3 层都在比「源码里写的类名」，没有一层在比「令牌自己的取值对不对」。
 *   已证实的假绿：`tests/themeTokens.test.ts` 17 条只守结构一致性，把 `--lx-text-muted`
 *   改回错值 `#71717a` 时 17/17 全绿逃逸。本层把「令牌当前值」与「代言类名在 dist 产物
 *   里的真实取值」归一化后逐条比对（容差同 TOL），真值源在
 *   `frontend/scripts/theme-spec/token-value-spec.json`。产物缺失/过期一律判 1，不静默通过。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么退出码是 0 / 2 * 为什么退出码是 0 / 2
 * ────────────────────────────────────────────────────────────────
 *   0 = 零漂移（可合）
 *   2 = 有漂移/告警（不许合，需人工确认或修回去）
 *   1 = 无法执行（产物缺失之类的基础设施问题，**不是**「等价」，必须与 2 区分开：
 *       把「环境没准备好」伪装成「通过」是历史事故的根源）
 *
 * ────────────────────────────────────────────────────────────────
 * 前置
 * ────────────────────────────────────────────────────────────────
 *   `cd frontend && npm run build`（或 `npx vite build`）产出 frontend/dist/assets/*.css。
 *   改造后不重新 build，产物里没有新的令牌类 → 第 1 层会把合法改造判成「不可解析」。
 *
 * ────────────────────────────────────────────────────────────────
 * 路径自解析（历史坑，别改回去）
 * ────────────────────────────────────────────────────────────────
 * 本文件在 frontend/scripts/ 下，**用 import.meta.url 推仓库根**，既不用
 * `path.resolve('.', '..', ...)`（依赖 cwd，从仓库根跑就指向 D:\ ），也不用
 * 「往上数 3 层」（换个目录就指向 D:\frontend）。任意 cwd 调用结果一致。
 *
 * 用法：
 *   node scripts/check-theme-equivalence.mjs                          # 全量 58 个 .vue，默认 --base HEAD
 *   node scripts/check-theme-equivalence.mjs src/views/settings/tabs/AboutTab.vue
 *   node scripts/check-theme-equivalence.mjs ..\src\views\settings\tabs\AboutTab.vue   # frontend 下相对路径
 *   node scripts/check-theme-equivalence.mjs frontend/src/x.vue --base HEAD             # 仓库根下相对路径
 *   node scripts/check-theme-equivalence.mjs --base origin/develop                     # PR 门禁
 *   node scripts/check-theme-equivalence.mjs --static-only                             # 只跑第 1 层（CI 用）
 *   node scripts/check-theme-equivalence.mjs --selftest
 *   node scripts/check-theme-equivalence.mjs --check-token-values          # 第 4 层：令牌数值校验
 *   node scripts/check-theme-equivalence.mjs --check-token-values --allow-stale
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FRONTEND_ROOT,
  loadThemeContext,
  loadThemeMap,
  loadThemeMapFromText,
  loadTokensFromText,
  normalizeColor,
  parseRgba,
  resolveClass
} from './check-theme-colors.mjs';

/** 本文件所在目录 = frontend/scripts */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：frontend/scripts → frontend → 仓库根 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** 令牌定义文件（相对仓库根），用于取基线版本 */
const TOKENS_REL = 'frontend/src/theme/tokens.css';
/** Tailwind 入口（@theme inline 桥接层，相对仓库根） */
const STYLE_REL = 'frontend/src/style.css';
/** 源码根：只扫这里，不扫 node_modules / dist */
const SRC_ROOT = path.join(FRONTEND_ROOT, 'src');

/**
 * 判等容差（可审计，不许随手改大）。
 * rgb：Tailwind v4 调色板 hex 化 + 本仓 oklch→sRGB 反算的 42 色交叉校验实测最大通道差 = 8。
 * alpha：8 位 hex 的量化误差上限（1/255 ≈ 0.0039），取 0.01 留余量。
 */
const TOL = { rgb: 8, alpha: 0.01 };

/** 令牌工具类前缀：命中但它解析不到，就是「写错令牌名」的静默失效 */
const TOKEN_CLASS_RE = /^(?:bg|text|border|border-[tb]|from|to|via|ring|fill|stroke|divide|placeholder|outline|shadow|accent|caret|decoration)-(?:lx|color-lx)-/;

/**
 * 是否是「像工具类」的 token（用于把字符串字面量里的类名挑出来）。
 * 目的不是完整复刻 Tailwind，而是让 `flex`/`mb-2.5` 这类非颜色类也进第 3 层严格比对。
 * @param {string} t 候选串
 * @returns {boolean} true = 当作工具类处理
 */
const isClassLike = (t) =>
  /^[a-z]/.test(t) && /[a-z]/.test(t) && !t.includes('(') &&
  /^(bg|text|border|from|to|via|ring|shadow|fill|stroke|divide|placeholder|outline|rounded|opacity|w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|flex|grid|items|justify|font|leading|tracking|absolute|relative|fixed|sticky|overflow|truncate|select|transition|duration|cursor|pointer|inset|top|left|right|bottom|z|min|max|space|whitespace|break|col|row|order|self|content|aspect|object|align|line|indicator|animate|scale|rotate|translate|drop|backdrop|blur|sr|group|peer|hover|focus|active|disabled|dark|appearance|resize|accent|caret|decoration|underline|uppercase|lowercase|capitalize|italic|antialiased|subpixel|list|block|inline|hidden|contents|static|table|isolate|pointer-events|snap|touch|will|contain|backface|perspective|origin|transform)-/.test(t) ||
  /^(block|inline|flex|grid|hidden|contents|static|relative|absolute|fixed|sticky|truncate|italic|underline|uppercase|lowercase|capitalize|antialiased|transition|transform|pointer-events-none|select-none|rounded|border|shadow|ring|outline-none|opacity-0|table|list-none|appearance-none|resize-none|isolate|overflow-hidden|overflow-auto|overflow-y-auto|overflow-x-auto|sr-only)$/.test(t);

/**
 * 从一个字符串字面量里收出颜色类与字面量类。
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @param {string} lit 字面量内容（如 `text-zinc-400 flex` ）
 * @param {'dark'|'light'} mode 明暗模式
 * @returns {{colors: Array<{prop: string, value: string, cls: string, token: boolean}>, raw: string[]}} 颜色项（含是否令牌类）+ 非颜色类名
 */
/**
 * 变体前缀解析：`dark:hover:bg-white/10` → { variants: ['dark','hover'], base: 'bg-white/10' }。
 *
 * 为什么需要：dist 产物里**根本没有 `dark:` 变体类**（实测 keys 中 hover:/placeholder: 有，dark: 为空），
 * 而 `isClassLike` 只认 `dark-` 不认 `dark:`，导致所有变体类既不进颜色组也不进字面量多重集——
 * 删掉一个 `dark:text-zinc-400` 这种真实渲染变化，门禁会判「等价」。这里把变体剥掉后按基础类解析，
 * 再由 `collect` 按「dark: 只暗态生效 + 覆盖同属性基础类」重建明暗有效集。
 * @param {string} cls 原始类名
 * @returns {{variants: string[], base: string}} 变体列表与基础类
 */
const splitVariant = (cls) => {
  const i = cls.lastIndexOf(':');
  if (i <= 0 || i === cls.length - 1) return { variants: [], base: cls };
  return { variants: cls.slice(0, i).split(':'), base: cls.slice(i + 1) };
};

const collect = (ctx, lit, mode) => {
  /** @type {Array<{prop: string, value: string, cls: string, token: boolean, darkOnly: boolean}>} */
  const entries = [];
  const colors = [];
  /** @type {string[]} */
  const raw = [];
  for (const cls of String(lit).split(/\s+/)) {
    if (cls === '') continue;
    const { variants, base } = splitVariant(cls);
    if (!isClassLike(base) && !isClassLike(cls)) continue;
    const darkOnly = variants.includes('dark');
    const r = resolveClass(ctx, base, mode) ?? resolveClass(ctx, cls, mode);
    if (!r || !parseRgba(r.value)) {
      raw.push(cls);
      continue;
    }
    entries.push({ prop: r.prop, value: r.value, cls, token: TOKEN_CLASS_RE.test(base), darkOnly });
  }
  // 明暗有效集：`dark:` 变体只在暗态生效，且暗态覆盖同属性的基础类取值
  // （这正是 `text-gray-500 dark:text-zinc-400` 的真实语义：亮取 gray-500、暗取 zinc-400）。
  const darkOnlyProps = new Set(entries.filter((e) => e.darkOnly).map((e) => e.prop));
  for (const e of entries) {
    if (e.darkOnly && mode !== 'dark') continue;
    if (!e.darkOnly && mode === 'dark' && darkOnlyProps.has(e.prop)) continue;
    colors.push({ prop: e.prop, value: e.value, cls: e.cls, token: e.token });
  }
  return { colors, raw };
};

/** 三元配对（暗侧/亮侧各一个单引号字面量） */
const TERNARY_RE = /\?\s*'([^'\\\n]*)'\s*:\s*'([^'\\\n]*)'/g;
/** 字符串字面量：单引号优先，其次双引号（属性值也是「字符串字面量」，与 class='...' 同权） */
const LITERAL_RE = /'([^'\\\n]{1,400})'|"([^"\\\n]{1,400})"/g;

/**
 * 扫一段源码文本，把三元分支 / 中性字面量 / 字面量类分别累积进分组结果。
 *
 * 关键点（都是踩过的坑）：
 *   1. **属性值容器**：`:class="isDark ? 'a' : 'b'"` 会被双引号分支整体命中，内容里既有单引号又有三元。
 *      直接当字面量 split 会产出 `text-zinc-400'` 这类**带引号的幽灵类名**（假漂移噪音），
 *      而且要是在本层跳过整段，就会连 `['text-xs', …]` 里的 `text-xs` 一起看不见（漏检）。
 *      所以：内容含单引号的双引号命中一律视为**容器**，只向内递归一层，本层不重复计。
 *   2. 同一份文本里，落在容器内的三元由递归负责计数，本层必须跳过，否则双重计数。
 *   3. 令牌类必须按「主题相关」处理：暗侧值进 dark 组、亮侧值进 light 组（详见下方注释）。
 *
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @param {string} src 待扫文本
 * @param {{dark: Array<{prop: string, value: string}>, light: Array<{prop: string, value: string}>, neutral: Array<{prop: string, d: string|null, l: string|null}>, raw: string[], counters: {darkBranch: number, lightBranch: number, neutral: number}}} g 累积目标
 * @param {number} depth 递归深度（容器最多再进 3 层，防止病态嵌套）
 * @returns {void}
 */
const scanText = (ctx, src, g, depth) => {
  /** @type {Array<[number, number]>}「属性值容器」区间（双引号命中且内容含单引号） */
  const containers = [];
  for (const m of src.matchAll(LITERAL_RE)) {
    if (m[1] === undefined && (m[2] ?? '').includes("'")) {
      const start = m.index ?? 0;
      containers.push([start, start + m[0].length]);
    }
  }
  const withinContainers = (start, len) =>
    containers.some(([s, e]) => start >= s && start + len <= e);

  /** @type {Array<[number, number]>} 本层已归属三元的区间 */
  const consumed = [];
  for (const m of src.matchAll(TERNARY_RE)) {
    const start = m.index ?? 0;
    const len = m[0].length;
    if (withinContainers(start, len)) continue; // 交给递归计，避免双重计数
    consumed.push([start, start + len]);
    const d = collect(ctx, m[1], 'dark');
    const l = collect(ctx, m[2], 'light');
    g.dark.push(...d.colors);
    g.light.push(...l.colors);
    g.rawDark.push(...d.raw);
    g.rawLight.push(...l.raw);
    if (d.colors.length > 0) g.counters.darkBranch += 1;
    if (l.colors.length > 0) g.counters.lightBranch += 1;
  }
  const inTernary = (start, len) => consumed.some(([s, e]) => start < e && start + len > s);

  for (const m of src.matchAll(LITERAL_RE)) {
    const start = m.index ?? 0;
    const content = m[1] ?? m[2] ?? '';
    if (m[1] === undefined && content.includes("'")) {
      if (depth < 3) scanText(ctx, content, g, depth + 1);
      continue;
    }
    if (inTernary(start, m[0].length)) continue;
    // 统一模型：任何颜色贡献都按「明暗两态各自的生效值」归属，不再有「中性字面量要求暗亮同值」这一层。
    // 理由：渲染等价 = 明态集合等价 且 暗态集合等价，这是唯一有意义的判据；
    // 旧的中性模型既误杀令牌类（暗亮本就不同值），又看不见 dark: 变体（变体类根本没进候选集）。
    const d = collect(ctx, content, 'dark');
    const l = collect(ctx, content, 'light');
    g.rawDark.push(...d.raw);
    g.rawLight.push(...d.raw);
    if (d.colors.length === 0 && l.colors.length === 0) continue;
    g.counters.neutral += 1;
    g.dark.push(...d.colors);
    g.light.push(...l.colors);
  }
};

const groupsOf = (ctx, source) => {
  /** @type {{dark: Array<{prop: string, value: string}>, light: Array<{prop: string, value: string}>, neutral: Array<{prop: string, d: string|null, l: string|null}>, raw: string[], unknown: string[], counters: {darkBranch: number, lightBranch: number, neutral: number}}} */
  const g = {
    dark: [],
    light: [],
    neutral: [],
    raw: [],
    rawDark: [],
    rawLight: [],
    unknown: [],
    counters: { darkBranch: 0, lightBranch: 0, neutral: 0 }
  };
  scanText(ctx, String(source), g, 0);
  // 第 1 层：命中令牌前缀却解析不到的，就是写错/不存在的令牌类
  g.raw = [...g.rawDark, ...g.rawLight];
  g.unknown = [...new Set(g.raw)].filter((c) => TOKEN_CLASS_RE.test(c));
  return g;
};

/**
 * alpha 是否在容差内相等。
 * @param {string} a 归一化颜色
 * @param {string} b 归一化颜色
 * @returns {boolean} true = 相等
 */
const closeAlpha = (a, b) => {
  const pa = parseRgba(a);
  const pb = parseRgba(b);
  if (!pa || !pb) return a === b;
  return Math.abs(pa.a - pb.a) <= TOL.alpha;
};

/**
 * RGB 最大通道差。
 * @param {string} a 归一化颜色
 * @param {string} b 归一化颜色
 * @returns {number} 最大通道差；非颜色可比时返回 999
 */
const rgbDelta = (a, b) => {
  const pa = parseRgba(a);
  const pb = parseRgba(b);
  if (!pa || !pb) return a === b ? 0 : 999;
  return Math.max(Math.abs(pa.r - pb.r), Math.abs(pa.g - pb.g), Math.abs(pa.b - pb.b));
};

/**
 * 带容差的颜色相等判定。
 * @param {string} a 归一化颜色
 * @param {string} b 归一化颜色
 * @returns {boolean} true = 等价
 */
const near = (a, b) => closeAlpha(a, b) && rgbDelta(a, b) <= TOL.rgb;

/**
 * 按 CSS 属性分组 + 数值排序后配对比较（等价于带容差的多重集比对）。
 * @param {string} label 输出标签
 * @param {Array<{prop: string, value: string}>} A 旧
 * @param {Array<{prop: string, value: string}>} B 新
 * @returns {string[]} 问题列表
 */
/**
 * 两个颜色项是否等价（容差只对「令牌 vs 产物」生效）：
 * - 任一侧是令牌类 → 带容差：令牌值来自 tokens.css，产物值是 oklch 反算，高饱和色实测最大差 8/255；
 * - 两侧都是普通产物类 → 严格相等：同一个 Tailwind 类的取值是确定的，容差只会掩盖真实漂移
 *   （实测 `#9f9fa9`(zinc-400) 与 `#99a1af`(gray-400) 只差 6/255，被 8 的容差整条放过 = 漏检）。
 * @param {{prop: string, value: string, token?: boolean}} a 左侧项
 * @param {{prop: string, value: string, token?: boolean}} b 右侧项
 * @returns {boolean} true = 等价
 */
const sameEntry = (a, b) =>
  a.token || b.token ? near(a.value, b.value) : closeAlpha(a.value, b.value) && rgbDelta(a.value, b.value) === 0;

const compareColorGroups = (label, A, B) => {
  /** @param {Array<{prop: string, value: string}>} list */
  const bucketize = (list) => {
    /** @type {Map<string, Array<{prop: string, value: string}>>} */
    const m = new Map();
    for (const e of list) {
      const arr = m.get(e.prop) ?? [];
      arr.push(e);
      m.set(e.prop, arr);
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => {
        const px = parseRgba(x.value);
        const py = parseRgba(y.value);
        if (!px || !py) return String(x.value).localeCompare(String(y.value));
        return px.r - py.r || px.g - py.g || px.b - py.b || px.a - py.a;
      });
    }
    return m;
  };
  const ma = bucketize(A);
  const mb = bucketize(B);
  const problems = [];
  for (const prop of new Set([...ma.keys(), ...mb.keys()])) {
    const la = ma.get(prop) ?? [];
    const lb = mb.get(prop) ?? [];
    if (la.length !== lb.length) {
      problems.push(`[${label}] ${prop} 数量不一致：旧 ${la.length} / 新 ${lb.length}`);
      continue;
    }
    for (let i = 0; i < la.length; i += 1) {
      if (!sameEntry(la[i], lb[i])) {
        problems.push(`[${label}] ${prop} 值漂移：旧 ${la[i].value} → 新 ${lb[i].value}`);
      }
    }
  }
  return problems;
};

/**
 * 中性字面量比较（模块级单一取值，不分明暗）。
 * @param {Array<{prop: string, d: string|null, l: string|null}>} A 旧
 * @param {Array<{prop: string, d: string|null, l: string|null}>} B 新
 * @returns {string[]} 问题列表
 */
const compareNeutral = (A, B) => {
  const key = (e) => e.prop + '|' + (e.d ?? '') + '|' + (e.l ?? '');
  const sortFn = (x, y) => key(x).localeCompare(key(y));
  const la = [...A].sort(sortFn);
  const lb = [...B].sort(sortFn);
  const problems = [];
  if (la.length !== lb.length) problems.push(`[neutral] 数量不一致：旧 ${la.length} / 新 ${lb.length}`);
  const n = Math.min(la.length, lb.length);
  for (let i = 0; i < n; i += 1) {
    const x = la[i];
    const y = lb[i];
    const okD = x.d === null || y.d === null ? x.d === y.d : near(x.d, y.d);
    const okL = x.l === null || y.l === null ? x.l === y.l : near(x.l, y.l);
    if (x.prop !== y.prop || !okD || !okL) {
      problems.push(`[neutral] ${x.prop} 旧(${x.d} / ${x.l}) → 新(${y.prop} ${y.d} / ${y.l})`);
    }
  }
  return problems;
};

/**
 * 非颜色类多重集严格比较。
 * @param {string[]} A 旧
 * @param {string[]} B 新
 * @returns {string[]} 问题列表
 */
const compareRaw = (A, B) => {
  /** @param {string[]} list */
  const count = (list) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const c of list) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  };
  const ma = count(A);
  const mb = count(B);
  const problems = [];
  for (const [k, v] of ma) if ((mb.get(k) ?? 0) < v) problems.push(`[raw] 少了 ${v - (mb.get(k) ?? 0)}x ${k}`);
  for (const [k, v] of mb) if ((ma.get(k) ?? 0) < v) problems.push(`[raw] 多了 ${v - (ma.get(k) ?? 0)}x ${k}`);
  return problems;
};

/**
 * 从 git 取某文件在指定基线版本的内容。
 * @param {string} relPath 相对仓库根的路径（正斜杠）
 * @param {string} base git ref
 * @returns {string | null} 内容；null = 该基线里没有此文件（新增文件）
 */
const readBaseFile = (relPath, base) => {
  try {
    return execFileSync('git', ['show', `${base}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
};

/**
 * 把一个用户传入的路径规范成「相对仓库根的正斜杠路径」。
 * 同时接受相对 cwd、相对 frontend/、相对仓库根三种写法。
 * @param {string} input 原始参数
 * @returns {string} 相对仓库根的路径
 * @throws {Error} 路径落在仓库外或文件不存在时抛出
 */
const toRepoRelative = (input) => {
  const raw = path.resolve(process.cwd(), input);
  const rel = path.relative(REPO_ROOT, raw);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径不在仓库内：${input}`);
  }
  return rel.split(path.sep).join('/');
};

/**
 * 递归列出 src 下全部 .vue 文件。
 * @param {string} dir 目录
 * @returns {string[]} 绝对路径列表（已排序）
 */
const listVueFiles = (dir) => {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.vue')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
};

/**
 * 第 1 层：静态令牌可达性（不需要 git 基线，CI 里唯一有意义的一层）。
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @param {string} relPath 相对仓库根的路径
 * @returns {string[]} 问题列表
 */
const staticCheck = (ctx, relPath) => {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return [`[static] 文件不存在：${relPath}`];
  const g = groupsOf(ctx, fs.readFileSync(abs, 'utf8'));
  const problems = [];
  for (const c of g.unknown) {
    problems.push(`[static] ${c} —— 产物里解析不到该令牌类（Tailwind 不产出规则，等于没写；多半是令牌名写错）`);
  }
  return problems;
};

/** 
 * 构造「基线侧」的解析上下文：令牌表与桥接层都取基线版本。
 *
 * 为什么必须这样：若两侧都用当前 tokens.css，令牌取值被改错时两侧一起变，
 * 漂移会被静默吞掉（「改坏令牌值」这条变异就抓不到）。产物变量表（Tailwind 调色板）
 * 与 dist 仍共用当前构建产物 —— 调色板是框架常量，不随本次改造变化。
 *
 * @param {ReturnType<typeof loadThemeContext>} ctx 当前上下文
 * @param {string} base git 基线 ref
 * @returns {ReturnType<typeof loadThemeContext>} 基线上下文
 */
const buildBaseContext = (ctx, base) => {
  const tokensText = readBaseFile(TOKENS_REL, base);
  const styleText = readBaseFile(STYLE_REL, base);
  return {
    ...ctx,
    tokens: tokensText === null ? ctx.tokens : loadTokensFromText(tokensText),
    themeMap: styleText === null ? ctx.themeMap : loadThemeMapFromText(styleText)
  };
};

/**
 * 令牌表漂移检查：基线 vs 当前，同名令牌取值变化即报告。
 *
 * 为什么单独查：令牌是被所有组件共享的「公共契约」，改它等于全局视觉变更。
 * 新增令牌不算漂移（纯增量），改值/删值必须显式暴露出来由人确认。
 *
 * @param {ReturnType<typeof loadThemeContext>} baseCtx 基线上下文
 * @param {ReturnType<typeof loadThemeContext>} ctx 当前上下文
 * @returns {string[]} 问题列表
 */
const compareTokenTables = (baseCtx, ctx) => {
  const problems = [];
  for (const mode of ['dark', 'light']) {
    const a = baseCtx.tokens[mode];
    const b = ctx.tokens[mode];
    for (const key of Object.keys(a)) {
      if (!(key in b)) {
        problems.push(`[token:${mode}] 令牌被删除：${key}（旧 ${a[key]}）`);
        continue;
      }
      const va = normalizeColor(a[key]);
      const vb = normalizeColor(b[key]);
      if (va !== null && vb !== null) {
        if (!near(va, vb)) problems.push(`[token:${mode}] 令牌取值漂移：${key} 旧 ${va} → 新 ${vb}`);
      } else if (String(a[key]).trim() !== String(b[key]).trim()) {
        // 非颜色令牌（圆角/阴影/模糊）：严格字符串比，不留容差
        problems.push(`[token:${mode}] 令牌取值漂移：${key} 旧 ${String(a[key]).trim()} → 新 ${String(b[key]).trim()}`);
      }
    }
  }
  return problems;
};

/**
 * 递归取目录内最新 mtime（毫秒）。
 * @param {string} dir 目录
 * @returns {{time: number, file: string}} 最新 mtime 与对应文件（相对仓库根）
 */
const newestMtime = (dir) => {
  let time = 0;
  let file = '';
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs > time) {
        time = st.mtimeMs;
        file = path.relative(REPO_ROOT, p).split(path.sep).join('/');
      }
    }
  };
  walk(dir);
  return { time, file };
};

/**
 * 产物过期检测（第 -1 层）。
 *
 * 为什么必须有：门禁读的是 `frontend/dist/assets/*.css`。若有人改了组件却忘了
 * `vite build`，门禁会拿**旧产物**去解析，源码里的新令牌类在旧产物里当然不存在
 * —— 反过来，源码改回旧类名时旧产物也「恰好对得上」，于是**假绿**。
 * 一个会假绿的门禁等于没有门禁，所以这里直接判 1（基础设施问题），不判 0（等价）。
 *
 * mtime 可靠性说明：git clone 时源码全为 checkout 时间、而 dist 不入库，是先 checkout
 * 后 build，顺序天然正确；CI 里 dist 由同一次 `npm run build` 产出，也正确。
 * 若在特殊环境（如制品还原导致 mtime 乱序）确实需要放行，用 `--allow-stale` 显式声明。
 *
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @returns {{stale: boolean, cssTime: number, srcTime: number, cssFile: string, srcFile: string}} 判定结果
 */
const checkFreshness = (ctx) => {
  const cssList = ctx.built.filePaths;
  let cssTime = 0;
  let cssFile = '';
  for (const p of cssList) {
    const st = fs.statSync(p);
    if (st.mtimeMs > cssTime) {
      cssTime = st.mtimeMs;
      cssFile = path.relative(REPO_ROOT, p).split(path.sep).join('/');
    }
  }
  const newestSrc = newestMtime(SRC_ROOT);
  return {
    stale: newestSrc.time > cssTime,
    cssTime,
    srcTime: newestSrc.time,
    cssFile,
    srcFile: newestSrc.file
  };
};

// ---------------------------------------------------------------------------
// 第 4 层 · 令牌值 == 代言类名产物真实值（数值校验）
// ---------------------------------------------------------------------------
//
// 为什么必须有这一层（已证实的假绿漏洞）：
//   `tests/themeTokens.test.ts` 只守**结构**一致性（令牌名存在、桥接层有条目、明暗都有值）。
//   把 `--lx-text-muted` 改回错值 `#71717a` 时，那 17 条用例 **17/17 全绿**照样逃逸——
//   「令牌值对不对」过去只能人工 audit。
//   本层把「令牌当前值」与「代言类名在 dist 产物里的真实取值」逐条比对，才是机器判据。
//
// 真值源：frontend/scripts/theme-spec/token-value-spec.json
//   （由 .lingxi/tmp/m3/m3a-class-map.json 迁入；运行期不依赖 .lingxi 或任何仓库外路径）
//
// 比对口径：**归一化后比 + 容差**
//   归一化：rgba() ⇄ #rrggbb@a、#rgb ⇄ #rrggbb、alpha 补足三位小数、oklch 反算、color-mix 按 8 位量化。
//   容差：沿用 TOL（rgb ≤ 8、alpha ≤ 0.01）。高饱和色（cyan/amber）在「设计侧字面量」
//   与「产物侧 hex」两条独立推导间必然差几个通道，那是解析精度不是设计漂移；
//   拿严格字符串判等会在合法树上误红，而 TOL=8 对「改错值」这类真实漂移（例如
//   #9f9fa9 → #71717a 差 46）依然必红。

/** 真值源（相对仓库根，仅用于日志展示） */
const SPEC_REL = 'frontend/scripts/theme-spec/token-value-spec.json';
/** 真值源绝对路径：用 import.meta.url 解析，从 frontend/ 或仓库根调用结果一致 */
const SPEC_FILE = path.join(__dirname, 'theme-spec', 'token-value-spec.json');
/** 真值源每条记录必须具备的字段（缺字段 = 真值源损坏，必须显式报错而不是跳过） */
const SPEC_FIELDS = [
  'token',
  'name',
  'group',
  'status',
  'darkClass',
  'lightClass',
  'expectedDark',
  'expectedLight',
  'themeKey',
  'utilityClass'
];

/**
 * 把「已经是归一化口径」的字符串补成规范形式（alpha 三位小数，≥1 视为不透明）。
 * 必须先认这个分支：`normalizeColor()` 只吃 CSS 原串，**不认** `#rrggbb@a` 这种本仓
 * 自定义口径，直接喂给它会被判成「不是颜色」→ 误报「代言类名不可解析」（踩过）。
 *
 * @param {string} s 候选串
 * @returns {string | null} 规范形式，或 null（不是归一化口径）
 */
const canonicalColor = (s) => {
  const m = s.match(/^(#[0-9a-f]{6})(?:@([\d.]+))?$/);
  if (!m) return null;
  if (m[2] === undefined) return m[1];
  const a = Number(m[2]);
  if (!Number.isFinite(a) || a >= 1) return m[1];
  return m[1] + '@' + a.toFixed(3);
};

/**
 * 颜色归一化（严格口径，供数值校验使用）。
 * 与原型 `.lingxi/tmp/m3/verify-token-values.mjs` 的 `norm()` 同口径，
 * 但底层复用 `color-resolver`（check-theme-colors.mjs）的 `normalizeColor`，
 * 因此 `oklch()` / `color-mix()` 也能归一化，不必另写一套解析器。
 *
 * @param {unknown} raw 任意 CSS 颜色原串（也接受已归一化的 `#rrggbb[@a]`）
 * @returns {string | null} `#rrggbb` 或 `#rrggbb@0.xxx`；null = 无法归一化（不是颜色）
 */
const normColor = (raw) => {
  if (typeof raw === 'string') {
    const canonical = canonicalColor(raw.trim().toLowerCase());
    if (canonical !== null) return canonical;
  }
  const n = normalizeColor(raw);
  if (n === null) return null;
  return canonicalColor(n);
};

/**
 * 两条归一化颜色之间的距离，用于打印「差了多少」。
 * @param {string | null} want 期望（归一化）
 * @param {string | null} got 实际（归一化）
 * @returns {{rgb: number, alpha: number}} rgb = 最大通道差，alpha = |Δα|
 */
const colorGap = (want, got) => {
  const a = parseRgba(want);
  const b = parseRgba(got);
  if (!a || !b) return { rgb: Number.POSITIVE_INFINITY, alpha: Number.POSITIVE_INFINITY };
  return {
    rgb: Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)),
    alpha: Math.abs(a.a - b.a)
  };
};

/**
 * 读入并校验真值源。
 *
 * 校验为什么这么严：真值源被改坏（少一条令牌、字段改名）时若静默跳过，
 * 门禁就会「少检一条却仍然绿」——又一个假绿入口。
 *
 * @returns {{schemaVersion: number, tokens: Array<Record<string, string>>, compareContract: object, provenance: object}} 真值源
 * @throws {Error} 文件缺失 / JSON 损坏 / 结构不合法 / 令牌重复 时抛出
 */
const loadTokenValueSpec = () => {
  if (!fs.existsSync(SPEC_FILE)) {
    throw new Error(`真值源不存在：${SPEC_REL}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`真值源 JSON 解析失败（${SPEC_REL}）：${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`真值源结构不合法（${SPEC_REL}）：顶层必须是对象`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`真值源 schemaVersion 必须是 1，实际 ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.tokens) || parsed.tokens.length === 0) {
    throw new Error('真值源 tokens 必须是非空数组');
  }
  const seen = new Set();
  for (const [i, row] of parsed.tokens.entries()) {
    if (row === null || typeof row !== 'object') {
      throw new Error(`真值源 tokens[${i}] 不是对象`);
    }
    for (const field of SPEC_FIELDS) {
      if (typeof row[field] !== 'string' || row[field] === '') {
        throw new Error(`真值源 tokens[${i}] 缺少字段 ${field}`);
      }
    }
    if (!/^--lx-[a-z0-9-]+$/.test(row.token)) {
      throw new Error(`真值源 tokens[${i}].token 命名不合法：${row.token}`);
    }
    if (seen.has(row.token)) {
      throw new Error(`真值源令牌重复：${row.token}`);
    }
    seen.add(row.token);
  }
  return parsed;
};

/**
 * 第 4 层：令牌值 == 代言类名产物真实值 的数值校验。
 *
 * 每条令牌分暗/亮两侧做三件事（任何一件不成立都判非 0）：
 *   1. 令牌必须存在于 tokens.css 对应模式（否则门禁无从比对）；
 *   2. 代言类名必须能在全部 dist chunk 里解析出真实取值（解析不到 = 产物过期/类名写错，判死）；
 *   3. 令牌当前值 与 产物真实值、以及产物真实值 与 真值源 expected 必须在容差内一致。
 *
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文（dist 全 chunk + 令牌双套 + 桥接层）
 * @param {string[]} args 命令行参数（支持 --quiet / --allow-stale）
 * @returns {number} 退出码：0=全部一致，2=有 mismatch，1=无法执行（产物/真值源问题）
 */
const checkTokenValues = (ctx, args) => {
  const quiet = args.includes('--quiet');
  const allowStale = args.includes('--allow-stale');

  console.log('[gate:theme] 令牌数值校验（令牌值 == 代言类名产物真实值）');
  console.log('  仓库根    : ' + REPO_ROOT);
  console.log('  cwd       : ' + process.cwd());
  console.log('  真值源    : ' + SPEC_REL);
  console.log('  产物 chunk: ' + ctx.built.files.join(', ') + '（共 ' + ctx.built.files.length + ' 个）');
  console.log('  令牌 暗/亮: ' + Object.keys(ctx.tokens.dark).length + ' / ' + Object.keys(ctx.tokens.light).length);
  console.log('  容差      : rgb ≤ ' + TOL.rgb + '/255，alpha ≤ ' + TOL.alpha);

  // ---------- 前置 1：产物新鲜度（旧产物会让「令牌被改错」看起来没变 → 假绿） ----------
  const fresh = checkFreshness(ctx);
  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
  console.log('  产物最新  : ' + fmt(fresh.cssTime) + '  (' + fresh.cssFile + ')');
  console.log('  源码最新  : ' + fmt(fresh.srcTime) + '  (' + fresh.srcFile + ')');
  if (fresh.stale) {
    if (allowStale) {
      console.log('  ⚠ 产物早于源码，已按 --allow-stale 放行（结论可能是假绿，自行确认）');
    } else {
      console.error('\n[gate:theme] 构建产物早于源码，令牌数值校验拒绝判定。');
      console.error(`  源码最新 ${fmt(fresh.srcTime)}  →  ${fresh.srcFile}`);
      console.error(`  产物最新 ${fmt(fresh.cssTime)}  →  ${fresh.cssFile}`);
      console.error('  本校验读的是 dist 产物；旧产物会让「令牌被改成错值」看起来仍然一致，这是假绿。');
      console.error('  请先 `npm run build`（或 `npm run gate:theme:values:build`）。');
      return 1;
    }
  }

  // ---------- 前置 2：真值源可读且结构合法 ----------
  let spec;
  try {
    spec = loadTokenValueSpec();
  } catch (e) {
    console.error('\n[gate:theme] 无法加载令牌数值真值源：' + e.message);
    console.error('  真值源缺失/损坏时本校验无法判定，返回 1（无法执行）而不是 0（一致）。');
    return 1;
  }
  console.log('  真值源条目: ' + spec.tokens.length + ' 条');

  /**
   * 不一致明细（每条都带齐「令牌名 / 期望值 / 实际值 / 代言类名」四要素，便于直接定位）
   * @type {Array<{token: string, cls: string, want: string, got: string, note: string}>}
   */
  const problems = [];
  /** 两侧在容差内但不完全相等（高饱和色的解析精度差异），单独记录不算错 */
  /** @type {string[]} */
  const nearRows = [];
  let checked = 0;

  for (const row of spec.tokens) {
    for (const mode of ['dark', 'light']) {
      checked += 1;
      const cls = mode === 'dark' ? row.darkClass : row.lightClass;
      const expectedRaw = mode === 'dark' ? row.expectedDark : row.expectedLight;
      const want = normColor(ctx.tokens[mode][row.token]);
      const expected = normColor(expectedRaw);
      const resolved = resolveClass(ctx, cls, mode);
      const got = resolved === null ? null : normColor(resolved.value);
      const label = `${row.token} [${mode}]`;

      if (ctx.tokens[mode][row.token] === undefined) {
        problems.push({
          token: label,
          cls,
          want: '(tokens.css 缺失该令牌)',
          got: got ?? '(不可解析)',
          note: '令牌在 tokens.css 中不存在，门禁无从比对'
        });
        continue;
      }
      if (got === null) {
        problems.push({
          token: label,
          cls,
          want: want ?? String(ctx.tokens[mode][row.token]),
          got: '(产物中解析不到该代言类名)',
          note: '代言类名不可解析 = 产物过期或类名写错（Tailwind 不产出规则 = 静默失效），判死'
        });
        continue;
      }
      if (want === null) {
        problems.push({
          token: label,
          cls,
          want: '(令牌值无法归一化：' + String(ctx.tokens[mode][row.token]) + ')',
          got,
          note: '令牌取值不是可识别的颜色字面量'
        });
        continue;
      }
      if (expected === null) {
        problems.push({
          token: label,
          cls,
          want,
          got,
          note: '真值源 expected 无法归一化：' + String(expectedRaw)
        });
        continue;
      }

      // 1) 令牌当前值 vs 代言类名产物真实值（本层的主判据）
      if (!near(want, got)) {
        const gap = colorGap(want, got);
        problems.push({
          token: label,
          cls,
          want,
          got,
          note: `令牌值与代言类名产物真实值不一致（rgb 最大通道差 ${gap.rgb}，alpha 差 ${gap.alpha.toFixed(3)}，容差 rgb≤${TOL.rgb}/alpha≤${TOL.alpha}）`
        });
        continue;
      }
      if (want !== got) {
        const gap = colorGap(want, got);
        nearRows.push(`${label}  ${want} ≈ ${got}  (rgb 差 ${gap.rgb}，alpha 差 ${gap.alpha.toFixed(3)}，代言 ${cls}，在容差内)`);
      }

      // 2) 产物真实值 vs 真值源 expected（防止真值源或产物被悄悄改动后「共同漂移」）
      if (!near(expected, got)) {
        const gap = colorGap(expected, got);
        problems.push({
          token: label,
          cls,
          want: expected,
          got,
          note: `真值源 expected 与产物真实值不一致（rgb 最大通道差 ${gap.rgb}，alpha 差 ${gap.alpha.toFixed(3)}）；要么产物/调色板变了，要么真值源被改，二者必须一致`
        });
      }
    }
  }

  if (!quiet && nearRows.length > 0) {
    console.log('\n≈ 以下 ' + nearRows.length + ' 项在容差内（解析精度差异，不是漂移）：');
    for (const r of nearRows) console.log('    ' + r);
  }

  if (problems.length > 0) {
    console.log('\n✗ 令牌数值不一致：' + problems.length + ' 处。格式：令牌名 / 期望值 / 实际值 / 代言类名');
    for (const p of problems) {
      console.log('  ✗ ' + p.token);
      console.log('      令牌名  : ' + p.token);
      console.log('      期望值  : ' + p.want);
      console.log('      实际值  : ' + p.got);
      console.log('      代言类名: ' + p.cls);
      console.log('      说明    : ' + p.note);
    }
    console.log('\n== 结论：令牌数值校验未通过（' + problems.length + ' / ' + checked + ' 处不一致） ==');
    return 2;
  }

  console.log('\n✓ 全部 ' + spec.tokens.length + ' 条令牌（' + checked + ' 侧）与代言类名产物真实值一致');
  console.log('== 结论：令牌数值校验通过 ==');
  return 0;
};

/**
 * 完整检查单个文件：第 1 层 + 第 2/3 层（与基线比较）。
 * @param {ReturnType<typeof loadThemeContext>} ctx 当前解析上下文
 * @param {ReturnType<typeof loadThemeContext>} baseCtx 基线解析上下文
 * @param {string} relPath 相对仓库根路径
 * @param {string} base git 基线 ref
 * @param {boolean} staticOnly 只跑第 1 层
 * @returns {{problems: string[], drift: number, notes: string[]}} 结果
 */
const checkFile = (ctx, baseCtx, relPath, base, staticOnly) => {
  const problems = staticCheck(ctx, relPath);
  const notes = [];
  if (staticOnly) return { problems, drift: problems.length, notes };

  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return { problems, drift: problems.length + 1, notes };
  const nextSrc = fs.readFileSync(abs, 'utf8');
  const prevSrc = readBaseFile(relPath, base);
  if (prevSrc === null) {
    notes.push(`基线 ${base} 中无此文件（新增文件，跳过等价性比较，仅做静态检查）`);
    return { problems, drift: problems.length, notes };
  }
  if (prevSrc === nextSrc) {
    notes.push('与基线逐字节相同');
    return { problems, drift: problems.length, notes };
  }

  const A = groupsOf(baseCtx, prevSrc);
  const B = groupsOf(ctx, nextSrc);
  notes.push('三元计数 旧=' + JSON.stringify(A.counters) + ' 新=' + JSON.stringify(B.counters));

  const driftProblems = [
    ...compareColorGroups('dark', A.dark, B.dark),
    ...compareColorGroups('light', A.light, B.light),
    ...compareNeutral(A.neutral, B.neutral),
    ...compareRaw(A.rawDark, B.rawDark),
    ...compareRaw(A.rawLight, B.rawLight)
  ];
  return { problems: [...problems, ...driftProblems], drift: problems.length + driftProblems.length, notes };
};

/**
 * 门禁自检：用构造出来的源码串验证「能红也能绿」。
 * 门禁脚本自身写错 → 永远绿 → 是最坏的情况，所以必须自检。
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @returns {number} 0 = PASS，1 = FAIL
 */
const selftest = (ctx) => {
  let bad = 0;
  /**
   * @param {string} label 用例名
   * @param {boolean} ok 是否通过
   * @param {string} extra 附注
   */
  const check = (label, ok, extra = '') => {
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
    if (!ok) bad += 1;
  };

  console.log('容差 RGB≤' + TOL.rgb + ' alpha≤' + TOL.alpha);

  const before = "const c = isDark ? 'text-zinc-400' : 'text-gray-500'";
  const same = "const c = isDark ? 'text-zinc-400' : 'text-gray-500'";
  const moved = "const c = isDark ? 'text-lx-primary' : 'text-gray-500'";

  // 绿：完全没改
  const g0 = groupsOf(ctx, before);
  const g0b = groupsOf(ctx, same);
  check(
    '未改动 → 零漂移',
    [compareColorGroups('dark', g0.dark, g0b.dark), compareColorGroups('light', g0.light, g0b.light), compareRaw(g0.raw, g0b.raw)].every((x) => x.length === 0)
  );

  // 红：令牌替换后取值不等
  const g1 = groupsOf(ctx, moved);
  check('不等值令牌替换 → 报漂移', compareColorGroups('dark', g0.dark, g1.dark).length > 0, JSON.stringify(compareColorGroups('dark', g0.dark, g1.dark)));

  // 红：令牌名写错 → 静默失效
  const g2 = groupsOf(ctx, "const c = isDark ? 'text-lx-nope' : 'text-gray-500'");
  check('写错令牌名 → 报不可解析', g2.unknown.length === 1, JSON.stringify(g2.unknown));

  // 红：非颜色类改动也要报
  const g3 = groupsOf(ctx, "const c = 'flex mb-2.5'");
  const g4 = groupsOf(ctx, "const c = 'flex mb-3'");
  check('非颜色类改动 → 报字面量差异', compareRaw(g3.raw, g4.raw).length > 0, JSON.stringify(compareRaw(g3.raw, g4.raw)));

  // alpha 差异必须能抓到（不能因为只看 RGB 就放过半透明变化）
    // ---- dark: 变体通道（2026-10-21 新增）----
  // 历史盲区：变体类（dark:/hover:/focus:）根本进不了候选集，删掉一个 dark:text-zinc-400 也判「等价」。
  // 下面 5 条锁死新模型：折叠成令牌类必须绿，删/改变体必须红，近色不得被容差放过。
  const eqPair = (a, b) => {
    const ga = groupsOf(ctx, a);
    const gb = groupsOf(ctx, b);
    return [
      compareColorGroups('dark', ga.dark, gb.dark),
      compareColorGroups('light', ga.light, gb.light),
      compareRaw(ga.raw, gb.raw)
    ].every((x) => x.length === 0);
  };
  check('dark: 通道折叠成令牌类 → 判等绿', eqPair("const c = 'text-gray-500 dark:text-zinc-400'", "const c = 'text-lx-muted'"));
  check('删掉 dark: 变体 → 必红', !eqPair("const c = 'text-gray-500 dark:text-zinc-400'", "const c = 'text-gray-500'"));
  check('dark: 变体改值 → 必红', !eqPair("const c = 'text-gray-500 dark:text-zinc-400'", "const c = 'text-gray-500 dark:text-zinc-500'"));
  check('状态变体 hover: 改值 → 必红', !eqPair("const c = 'hover:bg-black/5'", "const c = 'hover:bg-black/10'"));
  check('近色不得被容差放过（zinc-400 vs gray-400，差 6/255）', !eqPair("const c = 'text-gray-400 dark:text-zinc-400'", "const c = 'text-gray-400'"));

const a1 = groupsOf(ctx, "const c = isDark ? 'bg-white/10' : 'bg-white'");
  const a2 = groupsOf(ctx, "const c = isDark ? 'bg-white' : 'bg-white'");
  check('alpha 变化 → 报漂移', compareColorGroups('dark', a1.dark, a2.dark).length > 0);

  // 容差边界：相等即绿（防止容差被写死成 0 导致误红）
  check('同值不同写法 → 判等价', near('#e4e4e7', '#e4e4e7'));
  check('超出容差 → 判不等', !near('#e4e4e7', '#d4d4d8'));

  // 第 0 层：令牌表改值必须被单独抓到（两侧共用当前令牌表会互相抵消 → 假绿）
  const fakeBaseCtx = {
    ...ctx,
    tokens: {
      dark: { ...ctx.tokens.dark, '--lx-text-tertiary': '#a1a1aa' },
      light: { ...ctx.tokens.light }
    }
  };
  const fakeCtx = {
    ...ctx,
    tokens: {
      dark: { ...ctx.tokens.dark, '--lx-text-tertiary': '#71717a' },
      light: { ...ctx.tokens.light }
    }
  };
  check('令牌表改值 → 报令牌漂移', compareTokenTables(fakeBaseCtx, fakeCtx).length > 0, JSON.stringify(compareTokenTables(fakeBaseCtx, fakeCtx)));
  check('令牌表未改 → 零令牌漂移', compareTokenTables(fakeCtx, fakeCtx).length === 0);

  // ---------- 第 4 层语义之外的模型自检：令牌类在「字面量」里也要被正确配对 ----------
  // 背景：M3 的合法改造形态是「三元 → 单个令牌类字面量」（规格书 §2.5 例 1/2/4）。
  // 令牌类编译成 var(--lx-*)，暗亮自动不同；若把它当中性字面量比，任何合法改造都会红，
  // 自检必须同时证明「合法折叠判绿」与「折叠到错令牌/单侧不等值判红」，否则这个放宽就是新假绿。
  const foldBase = "const c = isDark ? 'text-zinc-400' : 'text-gray-500'";
  const foldOk = "const c = 'text-lx-muted'";
  const foldBadToken = "const c = 'text-lx-tertiary'";
  const foldBadLight = "const c = 'text-lx-muted'";
  const foldOneSide = "const c = isDark ? 'text-zinc-400' : 'text-gray-400'";
  const foldAttr = ':class="\'text-lx-muted\'"';
  const foldAttrBase = ':class="isDark ? \'text-zinc-400\' : \'text-gray-500\'"';

  /** @param {string} a @param {string} b */
  const eqOf = (a, b) => {
    const A = groupsOf(ctx, a);
    const B = groupsOf(ctx, b);
    return [
      ...compareColorGroups('dark', A.dark, B.dark),
      ...compareColorGroups('light', A.light, B.light),
      ...compareNeutral(A.neutral, B.neutral),
      ...compareRaw(A.rawDark, B.rawDark),
    ...compareRaw(A.rawLight, B.rawLight)
    ];
  };

  check('三元 → 等价令牌类字面量：判等价', eqOf(foldBase, foldOk).length === 0, JSON.stringify(eqOf(foldBase, foldOk)));
  check('三元 → 不等价令牌类字面量：必红', eqOf(foldBase, foldBadToken).length > 0, JSON.stringify(eqOf(foldBase, foldBadToken)));
  check('同令牌但亮侧不等价：必红（防止整个模型无脑放绿）', eqOf(foldOneSide, foldBadLight).length > 0, JSON.stringify(eqOf(foldOneSide, foldBadLight)));
  check(':class="\'...\'"（属性值内套单引号）也能取到类名', eqOf(foldAttrBase, foldAttr).length === 0, JSON.stringify(eqOf(foldAttrBase, foldAttr)));
  check('带引号的幽灵类名不再进 raw（历史假漂移噪音）', groupsOf(ctx, foldAttrBase).raw.every((c) => !c.includes("'")), JSON.stringify(groupsOf(ctx, foldAttrBase).raw));

  // ---------- 第 4 层自检：归一化 + 容差 + 真值源结构 ----------
  check('归一化 rgba() ⇄ #rrggbb@a', normColor('rgba(255, 255, 255, 0.102)') === normColor('#ffffff1a'), normColor('rgba(255, 255, 255, 0.102)'));
  check('归一化 #rgb ⇄ #rrggbb', normColor('#fff') === '#ffffff', String(normColor('#fff')));
  check('归一化 oklch() 可识别', normColor('oklch(70.5% .015 286.067)') === '#9f9fa9', String(normColor('oklch(70.5% .015 286.067)')));
  check('非颜色值必须是 null（不得当成相等）', normColor('12px') === null && normColor('0 1px 2px rgba(0,0,0,.4)') === null);
  check(
    '令牌值改错 → 数值校验必红（历史假绿：#9f9fa9 → #71717a）',
    !near(normColor('#9f9fa9'), normColor('#71717a')),
    'rgb 差 ' + colorGap(normColor('#9f9fa9'), normColor('#71717a')).rgb
  );
  check('a 通道极小的改动也要红', !near(normColor('#ffffff@0.102'), normColor('#ffffff@0.05')));
  check('高饱和色两条推导路径在容差内 → 判绿', near(normColor('#00d2ef'), normColor('#00d3f2')));

  let spec = null;
  try {
    spec = loadTokenValueSpec();
    check('真值源可加载', spec.tokens.length === 20, 'tokens=' + spec.tokens.length);
  } catch (e) {
    check('真值源可加载', false, e.message);
  }
  if (spec !== null) {
    const unresolvable = [];
    const missingTokens = [];
    for (const row of spec.tokens) {
      if (ctx.tokens.dark[row.token] === undefined) missingTokens.push(row.token + '(dark)');
      if (ctx.tokens.light[row.token] === undefined) missingTokens.push(row.token + '(light)');
      if (resolveClass(ctx, row.darkClass, 'dark') === null) unresolvable.push(row.darkClass);
      if (resolveClass(ctx, row.lightClass, 'light') === null) unresolvable.push(row.lightClass);
    }
    check('真值源的令牌都在 tokens.css 里', missingTokens.length === 0, JSON.stringify(missingTokens));
    check('真值源的代言类名都能在产物里解析', unresolvable.length === 0, JSON.stringify(unresolvable));
  }

  console.log(bad === 0 ? '\nSELFTEST PASS' : '\nSELFTEST FAIL count=' + bad);
  return bad === 0 ? 0 : 1;
};

/**
 * 打印用法。
 * @returns {void}
 */
const printUsage = () => {
  console.log(
    [
      '用法：node scripts/check-theme-equivalence.mjs [选项] [文件...]',
      '',
      '选项：',
      '  --base <ref>     等价性比较的基线，默认 HEAD',
      '  --static-only    只跑第 1 层（令牌类可达性，不需要 git 基线）',
      '  --check-token-values  第 4 层数值校验：令牌值 == 代言类名产物真实值（不需要 git 基线）',
      '  --allow-stale    产物早于源码时仍继续（默认拒绝：旧产物会导致假绿）',
      '  --quiet          只输出汇总与问题',
      '  --selftest       跑门禁自检',
      '  --help           显示本帮助',
      '',
      '不传文件 = 全量扫描 frontend/src 下所有 .vue。',
      '退出码：0=零漂移，2=有漂移，1=无法执行。',
      '',
      '示例：',
      '  node scripts/check-theme-equivalence.mjs --check-token-values   # 令牌数值 vs 代言类名产物真实值',
      '  npm run gate:theme:values                                       # 同上（需先 build）',
      '  npm run gate:theme:values:build                                 # build + 数值校验'
    ].join('\n')
  );
};

/**
 * 主流程。
 * @returns {number} 进程退出码
 */
const main = () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }

  let ctx;
  try {
    ctx = loadThemeContext();
  } catch (e) {
    console.error('[gate:theme] 无法加载构建产物：' + e.message);
    console.error('  等价门禁的前置是 `npm run build` 的产物；产物缺失时本门禁无法判定，');
    console.error('  因此返回 1（无法执行）而**不是** 0（等价）——把环境没准备好伪装成通过是历史事故的根源。');
    return 1;
  }

  if (args.includes('--selftest')) return selftest(ctx);
  // 第 4 层单独成模式：只做「令牌值 == 代言类名产物真实值」的数值校验，不需要 git 基线
  if (args.includes('--check-token-values')) return checkTokenValues(ctx, args);

  const staticOnly = args.includes('--static-only');
  const quiet = args.includes('--quiet');
  const baseIdx = args.indexOf('--base');
  const base = baseIdx >= 0 ? args[baseIdx + 1] : 'HEAD';
  if (baseIdx >= 0 && (base === undefined || base.startsWith('--'))) {
    console.error('[gate:theme] --base 需要一个 git ref 参数');
    return 1;
  }
  if (!staticOnly) {
    try {
      execFileSync('git', ['rev-parse', '--verify', base], { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch {
      console.error(`[gate:theme] 基线 ref 无法解析：${base}（请先 git fetch，或用 --static-only）`);
      return 1;
    }
  }

  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
  /** @type {string[]} */
  let targets;
  if (positional.length > 0) {
    targets = positional.map(toRepoRelative);
  } else {
    targets = listVueFiles(SRC_ROOT).map((p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'));
  }

  console.log('[gate:theme] 主题令牌等价门禁');
  console.log('  仓库根   : ' + REPO_ROOT);
  console.log('  cwd      : ' + process.cwd());
  console.log('  产物 chunk: ' + ctx.built.files.join(', '));
  console.log('  令牌 暗/亮: ' + Object.keys(ctx.tokens.dark).length + ' / ' + Object.keys(ctx.tokens.light).length);
  console.log('  基线     : ' + (staticOnly ? '(仅静态检查)' : base));
  console.log('  目标文件 : ' + targets.length + ' 个');

  // ---------- 第 -1 层：产物新鲜度（否则门禁会拿旧产物比对 → 假绿） ----------
  const fresh = checkFreshness(ctx);
  const allowStale = args.includes('--allow-stale');
  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
  console.log('  产物最新 : ' + fmt(fresh.cssTime) + '  (' + fresh.cssFile + ')');
  console.log('  源码最新 : ' + fmt(fresh.srcTime) + '  (' + fresh.srcFile + ')');
  if (fresh.stale) {
    if (allowStale) {
      console.log('  ⚠ 产物早于源码，已按 --allow-stale 放行（结论可能是假绿，自行确认）');
    } else {
      console.error('\n[gate:theme] 构建产物早于源码，门禁拒绝判定。');
      console.error(`  源码最新 ${fmt(fresh.srcTime)}  →  ${fresh.srcFile}`);
      console.error(`  产物最新 ${fmt(fresh.cssTime)}  →  ${fresh.cssFile}`);
      console.error('  门禁读的是 dist 产物；源码比产物新时，旧的 dist 会让源码改动「看起来没变」，');
      console.error('  这是假绿。请先 `npm run build`（或 `npm run gate:theme:build`）。');
      console.error('  确实需要放行（如制品还原导致 mtime 乱序）时用 --allow-stale 显式声明。');
      return 1;
    }
  }

  let totalDrift = 0;
  let affected = 0;

  // ---------- 第 0 层：令牌表公共契约（改令牌 = 全局视觉变更，必须显式暴露） ----------
  const baseCtx = staticOnly ? ctx : buildBaseContext(ctx, base);
  if (!staticOnly) {
    const tokenProblems = compareTokenTables(baseCtx, ctx);
    if (tokenProblems.length > 0) {
      totalDrift += tokenProblems.length;
      affected += 1;
      console.log('\n✗ 令牌表（' + TOKENS_REL + '）  （' + tokenProblems.length + ' 处取值变化）');
      for (const p of tokenProblems) console.log('    ' + p);
    } else if (!quiet) {
      console.log('✓ 令牌表（' + TOKENS_REL + '）取值与基线一致');
    }
  }

  for (const relPath of targets) {
    const r = checkFile(ctx, baseCtx, relPath, base, staticOnly);
    if (r.problems.length > 0) {
      totalDrift += r.problems.length;
      affected += 1;
      console.log('\n✗ ' + relPath + '  （' + r.problems.length + ' 处问题）');
      for (const p of r.problems) console.log('    ' + p);
    } else if (!quiet) {
      console.log('✓ ' + relPath + (r.notes.length > 0 ? '  [' + r.notes.join('；') + ']' : ''));
    }
  }

  console.log('\n== 结论：' + (totalDrift === 0 ? '等价（零漂移）' : `存在 ${totalDrift} 处漂移/告警（${affected} 个文件），需人工确认`) + ' ==');
  return totalDrift === 0 ? 0 : 2;
};

process.exit(main());

