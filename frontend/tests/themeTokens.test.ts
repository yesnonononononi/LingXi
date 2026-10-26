import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  THEME_TOKEN_NAMES,
  THEME_TOKEN_META,
  OVERRIDABLE_TOKEN_NAMES,
  tokensByGroup
} from '../src/theme/tokens';
import { ALL_MAPPING_TABLES } from '../src/theme/mapping';

/**
 * 主题令牌层门禁（M2）。
 *
 * <p>令牌散落在三处：`theme/tokens.css`（定义，暗/亮两套）、`style.css` 的 `@theme inline`（映射成工具类）、
 * `theme/tokens.ts`（元数据/白名单）。三处只要有一处漏改，就会出现「改了半天颜色不变」的静默失效。
 * 本文件把三处的键集合钉成双向相等，并校验映射表里的类名都能落到真实存在的主题变量上。</p>
 *
 * <p><b>关于金丝雀</b>：本文件所有「不存在 / 集合为空」类断言，都必须先证明解析器本身能命中特征样本，
 * 否则 `findstr` 那种「检索式没生效还以为 0 处」的假绿会重演（见 plugin-frontend-program.md 事故记录）。</p>
 */

const read = (relPath: string) => readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');

/** 剥掉注释：文件头注释里也会出现 `html[data-theme="light"]` 之类的选择器字样，
 *  不剥就会把「注释里的选择器」当成真选择器，解析出错误块（本项目已经踩过一次同类假绿）。 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 从 CSS 文本里取出某个选择器块的正文（块内无嵌套花括号，简单配对即可） */
const extractBlock = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `未找到选择器块：${selector}`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `选择器 ${selector} 后没有 {`);
  const close = css.indexOf('}', open);
  assert.notEqual(close, -1, `选择器 ${selector} 的块没有闭合`);
  return css.slice(open + 1, close);
};

/** 抽取块内所有自定义变量名（去掉 --lx- 前缀），返回排序后的数组 */
const collectTokenNames = (blockBody: string, prefix = '--lx-'): string[] => {
  const names: string[] = [];
  const re = new RegExp(`${prefix.replace(/[-]/g, '\\-')}([-a-z0-9]+)\\s*:`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(blockBody)) !== null) names.push(match[1]);
  return names.sort();
};

const tokensCss = stripComments(read('../src/theme/tokens.css'));
const styleCss = stripComments(read('../src/style.css'));
const darkBlock = extractBlock(tokensCss, ':root {');
const lightBlock = extractBlock(tokensCss, 'html.light,');
const themeBlock = extractBlock(styleCss, '@theme inline');

const darkNames = collectTokenNames(darkBlock);
const lightNames = collectTokenNames(lightBlock);

const sortedNames = (list: readonly string[]) => [...list].sort();
const diff = (a: readonly string[], b: readonly string[]) => a.filter(item => !b.includes(item));

// ─────────────────────────────────────────────────────────────────────────────
// T1 解析器自证（金丝雀：先证明「能命中」，后面的「为空」才有意义）
// ─────────────────────────────────────────────────────────────────────────────

test('T1-1 金丝雀：解析器能从合成样本里抓到令牌名与颜色值', () => {
  const sample = `:root {\n  --lx-fake-token: #123456;\n  --lx-nested-check: rgba(1, 2, 3, 0.5);\n}`;
  const body = extractBlock(sample, ':root {');
  assert.deepEqual(collectTokenNames(body), ['fake-token', 'nested-check'], '解析器必须能命中合成样本');
});

test('T1-2 金丝雀：集合比对能识别出「只在一侧存在」的令牌', () => {
  const left = ['a', 'b'];
  const right = ['a'];
  assert.deepEqual(diff(left, right), ['b'], '单向差集必须非空');
  assert.deepEqual(diff(left, left), [], '同集合差集必须为空');
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 定义完整性：暗/亮两套 + TS 元数据三处一致
// ─────────────────────────────────────────────────────────────────────────────

test('T2-1 亮色块不得出现暗色块里没有的令牌（light ⊆ dark）', () => {
  assert.ok(darkNames.length > 0, '暗色块必须解析出令牌（否则是本用例自己失败）');
  assert.ok(lightNames.length > 0, '亮色块必须解析出令牌');
  assert.deepEqual(diff(lightNames, darkNames), [], '亮色块出现了暗色块里没有的令牌');
});

test('T2-2 theme/tokens.ts 的令牌名与 tokens.css 暗色块完全一致（双向差集为空）', () => {
  assert.deepEqual(diff(sortedNames(THEME_TOKEN_NAMES), darkNames), [], 'ts 里有、CSS 里没有的令牌');
  assert.deepEqual(diff(darkNames, sortedNames(THEME_TOKEN_NAMES)), [], 'CSS 里有、ts 里没有的令牌');
});

test('T2-3 除形态类（明暗共用一套值）外，每个令牌都必须在亮色块里给出覆盖值', () => {
  const missing = THEME_TOKEN_NAMES
    .filter(name => name !== 'ring' && name !== 'blur-panel'
      && [...THEME_TOKEN_META].find(token => token.name === name)?.group !== 'shape')
    .filter(name => !lightNames.includes(name));
  assert.deepEqual(missing, [], '以下令牌在亮色块里缺少覆盖值，切到亮色会残留暗色');
});

/**
 * 「明暗刻意同值」豁免集：形态类（radius/shadow 等）+ 反色白字。
 * 提升到模块级，供 T2-4（正向：非豁免不得同值）与 T2-5（反向：豁免必须真的同值）共用。
 * ⚠️ 两个方向都必须有，只留正向会让豁免集静默腐化（加进来的项永远不会被回收检查）。
 */
const SAME_BY_DESIGN: ReadonlySet<string> = new Set(
  THEME_TOKEN_META.filter(token => token.group === 'shape').map(token => token.name).concat([
    'text-on-accent' // 强调色之上的文字，明暗都必须白
  ])
);

test('T2-4 明暗取值相同只允许出现在豁免集（反色白字 + 形态类）', () => {
  const valueOf = (body: string, name: string) => {
    const match = body.match(new RegExp(`--lx-${name}\\s*:\\s*([^;]+);`));
    assert.ok(match, `未取到 --lx-${name} 的值`);
    return match[1].trim();
  };
  const identical = lightNames
    .filter(name => !SAME_BY_DESIGN.has(name) && valueOf(darkBlock, name) === valueOf(lightBlock, name));
  assert.deepEqual(identical, [], '以下令牌明暗取值相同，疑似复制粘贴后忘改色');
});

test('T2-5 豁免集反向断言：白名单里非形态类的令牌必须真的明暗同值（防止豁免腐化）', () => {
  const valueOf = (body: string, name: string) => {
    const match = body.match(new RegExp(`--lx-${name}\\s*:\\s*([^;]+);`));
    assert.ok(match, `未取到 --lx-${name} 的值`);
    return match[1].trim();
  };
  // 遍历豁免集本身，而不是另写一份清单——否则新增豁免项逃过反向检查
  const shapeNames = new Set(
    THEME_TOKEN_META.filter(token => token.group === 'shape').map(token => token.name)
  );
  for (const name of SAME_BY_DESIGN) {
    if (shapeNames.has(name)) continue;
    assert.equal(
      valueOf(darkBlock, name),
      valueOf(lightBlock, name),
      `豁免集里的 ${name} 明暗已不同值，应从 SAME_BY_DESIGN 里删除`
    );
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// T3 映射完整性：@theme 块必须覆盖每个令牌，且值指向对应 var()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 令牌短名 → 若映射成 Tailwind 工具类，则给出 @theme 里的变量名；`null` 表示**刻意不映射**
 * （ring 是复合值、scrollbar 只给 CSS 用，做成 bg-/text- 工具类没有语义）。
 * 刻意不映射的令牌会反向断言「确实不存在」，防止一边声明不映射、一边偷偷映射了一半。
 */
const THEME_KEY_OF_TOKEN: Readonly<Record<string, string | null>> = {
  'canvas': '--color-lx-canvas',
  'canvas-subtle': '--color-lx-canvas-subtle',
  /* 画布光晕只被背景层的 background-image 以 CSS var() 消费，做成 bg-/text- 工具类没有语义 */
  'canvas-glow-from': null,
  'canvas-glow-via': null,
  'surface': '--color-lx-surface',
  'surface-elevated': '--color-lx-surface-elevated',
  'surface-sunken': '--color-lx-surface-sunken',
  'surface-hover': '--color-lx-surface-hover',
  'surface-active': '--color-lx-surface-active',
  'surface-selected': '--color-lx-surface-selected',
  'overlay': '--color-lx-overlay',
  'text-primary': '--color-lx-primary',
  'text-primary-soft': '--color-lx-primary-soft',
  'text-secondary': '--color-lx-secondary',
  'text-tertiary': '--color-lx-tertiary',
  'text-muted': '--color-lx-muted',
  'text-faint': '--color-lx-faint',
  'text-inverse': '--color-lx-inverse',
  'text-on-accent': '--color-lx-on-accent',
  'border-subtle': '--color-lx-border-subtle',
  'border-faint': '--color-lx-border-faint',
  'border-default': '--color-lx-border',
  'border-strong': '--color-lx-border-strong',
  'border-focus': '--color-lx-border-focus',
  'accent': '--color-lx-accent',
  'accent-hover': '--color-lx-accent-hover',
  'accent-pressed': '--color-lx-accent-pressed',
  'accent-soft': '--color-lx-accent-soft',
  'accent-spark': '--color-lx-accent-spark',
  'info': '--color-lx-info',
  'info-soft': '--color-lx-info-soft',
  'success': '--color-lx-success',
  'success-soft': '--color-lx-success-soft',
  'warning': '--color-lx-warning',
  'warning-soft': '--color-lx-warning-soft',
  'danger': '--color-lx-danger',
  'danger-soft': '--color-lx-danger-soft',
  'danger-border': '--color-lx-danger-border',
  'code-bg': '--color-lx-code-bg',
  'code-text': '--color-lx-code-text',
  'inline-code-bg': '--color-lx-inline-code-bg',
  'diff-add-bg': '--color-lx-diff-add-bg',
  'diff-del-bg': '--color-lx-diff-del-bg',
  'radius-sm': '--radius-lx-sm',
  'radius-md': '--radius-lx-md',
  'radius-lg': '--radius-lx-lg',
  'radius-full': '--radius-lx-full',
  'shadow-1': '--shadow-lx-1',
  'shadow-2': '--shadow-lx-2',
  'shadow-3': '--shadow-lx-3',
  'ring': null,
  'blur-panel': '--blur-lx-panel',
  'scrollbar-thumb': null,
  'scrollbar-thumb-hover': null
};

test('T3-1 每个令牌要么有 @theme 映射，要么显式登记为「不映射」', () => {
  const unmapped = THEME_TOKEN_NAMES.filter(name => !(name in THEME_KEY_OF_TOKEN));
  assert.deepEqual(unmapped, [], '以下令牌没有登记到 THEME_KEY_OF_TOKEN');
  const missing = THEME_TOKEN_NAMES
    .filter(name => {
      const key = THEME_KEY_OF_TOKEN[name];
      return typeof key === 'string' && !new RegExp(`${key}\\s*:`).test(themeBlock);
    });
  assert.deepEqual(missing, [], '以下令牌在 style.css 的 @theme 块里缺少映射');
});

test('T3-1b 登记为「不映射」的令牌，@theme 里确实不得出现其映射键', () => {
  const declaredUnmapped = Object.entries(THEME_KEY_OF_TOKEN).filter(([, key]) => key === null).map(([name]) => name);
  assert.deepEqual(declaredUnmapped.sort(), ['canvas-glow-from', 'canvas-glow-via', 'ring', 'scrollbar-thumb', 'scrollbar-thumb-hover'], '「不映射」名单变化需同步本断言');
  const leaked = declaredUnmapped.filter(name => new RegExp(`--(color|radius|shadow|blur)-lx-${name}\\s*:`).test(themeBlock));
  assert.deepEqual(leaked, [], '以下令牌声明为不映射，却在 @theme 里出现了映射键');
});

test('T3-2 @theme 里每条颜色/圆角/阴影映射都必须指向 var(--lx-*)，不得写死值', () => {
  const lines = themeBlock.split('\n').filter(line => line.includes('--color-lx-') || line.includes('--radius-lx-') || line.includes('--shadow-lx-') || line.includes('--blur-lx-'));
  assert.ok(lines.length > 0, '必须解析到映射行');
  const hardcoded = lines.filter(line => !line.includes('var(--lx-'));
  assert.deepEqual(hardcoded.map(line => line.trim()), [], '以下映射写死了值，换主题时不会生效');
});

test('T3-3 @theme 里不得出现没有对应令牌定义的 --color-lx-* / --radius-lx-* / --shadow-lx-*', () => {
  const mappedVars = [...themeBlock.matchAll(/var\((--lx-[-a-z0-9]+)\)/g)].map(match => match[1]);
  assert.ok(mappedVars.length > 0, '必须从映射行里解析出 var() 引用');
  const dangling = mappedVars.filter(cssVar => !darkNames.includes(cssVar.replace('--lx-', '')));
  assert.deepEqual(dangling, [], '以下映射指向了不存在的令牌定义');
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 映射表（mapping.ts）可用性
// ─────────────────────────────────────────────────────────────────────────────

/** 把工具类名反推成它在 @theme 里依赖的主题变量 */
const classToThemeVar = (className: string): string | null => {
  const bg = className.match(/^bg-lx-([a-z0-9-]+)$/);
  if (bg) return `--color-lx-${bg[1]}`;
  const fg = className.match(/^text-lx-([a-z0-9-]+)$/);
  if (fg) return `--color-lx-${fg[1]}`;
  const border = className.match(/^border-lx-([a-z0-9-]+)$/);
  if (border) return `--color-lx-${border[1]}`;
  const rounded = className.match(/^rounded-lx-([a-z0-9-]+)$/);
  if (rounded) return `--radius-lx-${rounded[1]}`;
  const shadow = className.match(/^shadow-lx-([0-9])$/);
  if (shadow) return `--shadow-lx-${shadow[1]}`;
  return null;
};

test('T4-1 mapping.ts 里每个类名都能反推成主题变量，且该变量在 @theme 中存在', () => {
  const problems: string[] = [];
  for (const [tableName, table] of ALL_MAPPING_TABLES) {
    for (const [key, className] of Object.entries(table)) {
      const themeVar = classToThemeVar(className);
      if (!themeVar) {
        problems.push(`${tableName}.${key} = "${className}" 不是可识别的 lx 工具类`);
        continue;
      }
      if (!new RegExp(`${themeVar}\\s*:`).test(themeBlock)) {
        problems.push(`${tableName}.${key} = "${className}" 依赖的 ${themeVar} 在 @theme 中不存在`);
      }
    }
  }
  assert.deepEqual(problems, [], '映射表与 @theme 不一致');
});

test('T4-2 覆盖白名单只含颜色类令牌，形态/滚动条一律不可覆盖', () => {
  const forbiddenGroups = new Set(['shape', 'scrollbar']);
  const bad = THEME_TOKEN_META.filter(token => token.overridable && forbiddenGroups.has(token.group));
  assert.deepEqual(bad.map(token => token.name), [], '形态与滚动条令牌不得开放给主题包');
  assert.ok(OVERRIDABLE_TOKEN_NAMES.length > 0, '白名单不应为空');
  assert.equal(
    OVERRIDABLE_TOKEN_NAMES.length,
    tokensByGroup('surface').length + tokensByGroup('text').length + tokensByGroup('border').length +
      tokensByGroup('accent').length + tokensByGroup('status').length + tokensByGroup('code').length,
    '白名单数量必须等于颜色类令牌总数'
  );
});

test('T4-3 令牌名必须符合命名规范（禁止颜色名与色阶）', () => {
  const colorNameLike = /-(red|blue|green|yellow|zinc|gray|grey|slate|indigo|purple|pink|orange|amber|teal|cyan|sky|violet|rose|lime|emerald|fuchsia)-?\d*$/;
  const bad = THEME_TOKEN_NAMES.filter(name => colorNameLike.test(`-${name}`));
  assert.deepEqual(bad, [], '令牌名不得含颜色名或色阶（换肤时要能整体替换色相）');
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 死配置与首帧主题（防回归）
// ─────────────────────────────────────────────────────────────────────────────

test('T5-1 tailwind.config.js 不得重新变成「有效配置」（v4 不读它，写了也是死代码）', () => {
  const config = read('../tailwind.config.js');
  assert.ok(config.includes('墓碑'), '应保留说明性注释，防止后人以为它是配置');
  assert.ok(!/theme\s*:/.test(config), 'tailwind.config.js 不应再声明 theme（v4 无 @config，不生效）');
  assert.ok(!/colors\s*:/.test(config), 'tailwind.config.js 不应再声明 colors');
});

test('T5-2 index.html 的首帧主题脚本必须在模块加载前同步 dataset 与 class', () => {
  const html = read('../index.html');
  assert.ok(html.includes("localStorage.getItem('lingxi-theme')"), '首帧脚本应读取持久化的主题');
  assert.ok(html.includes('root.dataset.theme'), '首帧脚本应写 dataset.theme（tokens.css 亮色选择器依赖它）');
  assert.ok(html.includes("classList.toggle('light'"), '首帧脚本应同时切 class（存量 dark: 变体依赖它）');
});

test('T5-3 style.css 的 @theme 块必须声明为 inline（否则工具类取不到运行时变量）', () => {
  assert.ok(styleCss.includes('@theme inline'), '@theme 必须是 inline 形式');
});
