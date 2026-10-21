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
 * 为什么退出码是 0 / 2
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
 * @returns {{colors: Array<{prop: string, value: string}>, raw: string[]}} 颜色项 + 非颜色类名
 */
const collect = (ctx, lit, mode) => {
  /** @type {Array<{prop: string, value: string}>} */
  const colors = [];
  /** @type {string[]} */
  const raw = [];
  for (const cls of String(lit).split(/\s+/)) {
    if (cls === '' || !isClassLike(cls)) continue;
    const r = resolveClass(ctx, cls, mode);
    if (!r || !parseRgba(r.value)) {
      raw.push(cls);
      continue;
    }
    colors.push({ prop: r.prop, value: r.value });
  }
  return { colors, raw };
};

/**
 * 把一份 SFC 源码切成「三元双侧 / 中性字面量 / 字面量类多重集」三组。
 * @param {ReturnType<typeof loadThemeContext>} ctx 解析上下文
 * @param {string} source 源码文本
 * @returns {{dark: Array<{prop: string, value: string}>, light: Array<{prop: string, value: string}>, neutral: Array<{prop: string, d: string|null, l: string|null}>, raw: string[], unknown: string[], counters: {darkBranch: number, lightBranch: number, neutral: number}}}
 */
const groupsOf = (ctx, source) => {
  const src = String(source);
  const g = {
    dark: [],
    light: [],
    neutral: [],
    raw: [],
    unknown: [],
    counters: { darkBranch: 0, lightBranch: 0, neutral: 0 }
  };
  /** @type {Array<[number, number]>} 已归属三元的区间，避免同一串被重复计入中性层 */
  const consumed = [];
  for (const m of src.matchAll(/\?\s*'([^'\\\n]*)'\s*:\s*'([^'\\\n]*)'/g)) {
    consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    const d = collect(ctx, m[1], 'dark');
    const l = collect(ctx, m[2], 'light');
    g.dark.push(...d.colors);
    g.light.push(...l.colors);
    g.raw.push(...d.raw, ...l.raw);
    if (d.colors.length > 0) g.counters.darkBranch += 1;
    if (l.colors.length > 0) g.counters.lightBranch += 1;
  }
  const inside = (i) => consumed.some(([s, e]) => i >= s && i < e);

  for (const m of src.matchAll(/'([^'\\\n]{1,400})'|"([^"\\\n]{1,400})"/g)) {
    if (inside(m.index ?? 0)) continue;
    const lit = m[1] ?? m[2] ?? '';
    const d = collect(ctx, lit, 'dark');
    const l = collect(ctx, lit, 'light');
    g.raw.push(...d.raw);
    if (d.colors.length === 0 && l.colors.length === 0) continue;
    g.counters.neutral += 1;
    const n = Math.max(d.colors.length, l.colors.length);
    for (let i = 0; i < n; i += 1) {
      const pick = d.colors[i] ?? l.colors[i];
      g.neutral.push({
        prop: pick.prop,
        d: d.colors[i]?.value ?? null,
        l: l.colors[i]?.value ?? null
      });
    }
  }

  // 第 1 层：命中令牌前缀却解析不到的，就是写错/不存在的令牌类
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
      if (!near(la[i].value, lb[i].value)) {
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
    ...compareRaw(A.raw, B.raw)
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
      '  --allow-stale    产物早于源码时仍继续（默认拒绝：旧产物会导致假绿）',
      '  --quiet          只输出汇总与问题',
      '  --selftest       跑门禁自检',
      '  --help           显示本帮助',
      '',
      '不传文件 = 全量扫描 frontend/src 下所有 .vue。',
      '退出码：0=零漂移，2=有漂移，1=无法执行。'
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
