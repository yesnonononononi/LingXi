/**
 * 活动指示点（live dot）样式契约。
 *
 * 锁四件事：
 * 1. 样式独立成层且被引入；动画节奏与过程标题扫光同频（同一屏不能有两种频率的循环动画）。
 * 2. 全仓不再出现 Tailwind 默认 animate-pulse —— 它会让「进行中」的节奏跟着框架默认值漂移。
 * 3. 状态点颜色仍归调用方，样式层不掺配色（配色语义化是另一笔账）。
 * 4. reduced-motion 下降级为静态但仍弱于终态，不能被误读成已完成。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const css = read('src/styles/status-indicator.css');
const sweep = read('src/styles/loading-sweep.css');
const styleEntry = read('src/style.css');

/** 递归收集 src 下的源码文件（.vue / .ts），用于"全仓不得回退"类断言。 */
function collectSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function ruleBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
  return match ? match[1] : null;
}

function seconds(source, animationName) {
  const match = new RegExp(`animation:\\s*${animationName}\\s+([\\d.]+)s`).exec(source);
  return match ? Number(match[1]) : null;
}

test('活动指示样式必须被入口样式表引入', () => {
  assert.match(styleEntry, /@import\s+"\.\/styles\/status-indicator\.css";/,
    'style.css 未引入 status-indicator.css，组件挂了类也不会有效果');
});

test('活动指示类存在并驱动呼吸动画', () => {
  const block = ruleBlock(css, '.lx-live-dot');
  assert.notEqual(block, null, '未解析到 .lx-live-dot 样式块，后续断言不成立');
  assert.match(css, /@keyframes\s+lx-live-dot-pulse\s*\{/, '缺少呼吸关键帧');
  assert.match(block, /animation:\s*lx-live-dot-pulse/, '样式块必须引用呼吸关键帧');
});

test('活动指示与标题扫光同频', () => {
  const dot = seconds(css, 'lx-live-dot-pulse');
  const shine = seconds(sweep, 'lx-sweep-text-shift');
  assert.notEqual(dot, null, '未能解析活动指示的动画时长');
  assert.notEqual(shine, null, '未能解析扫光的动画时长');
  assert.equal(dot, shine, `活动指示 ${dot}s 与扫光 ${shine}s 不同频，同屏两种节奏会显得卡`);
});

test('样式层不掺配色，颜色仍归调用方', () => {
  // 注释里会举色值例子说明取舍，断言只看真实代码。
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, '样式层不应写死色值');
  assert.doesNotMatch(code, /rgba?\(/, '样式层不应写死色值');
  assert.doesNotMatch(code, /\bbg-[a-z]+-\d+\b/, '颜色类应由调用方给出，不在样式层绑定');
});

test('减弱动态效果下不闪但仍弱于终态', () => {
  const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/.exec(css);
  assert.notEqual(media, null, '缺少 prefers-reduced-motion 降级块');
  const block = ruleBlock(media[0], '.lx-live-dot');
  assert.notEqual(block, null, '降级块里没有 .lx-live-dot');
  assert.match(block, /animation:\s*none/, '降级时必须停掉动画');
  assert.match(block, /opacity:\s*0?\.\d+/, '降级后仍要比终态弱，否则会被读成已完成');
});

test('全仓不再使用 Tailwind 默认 animate-pulse', () => {
  // 注释里允许解释「为什么不用它」，所以剥离注释后再扫：豁免整个文件会放过真实回退。
  const stripComments = text => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const offenders = collectSources(path.join(root, 'src'))
    .filter(file => /animate-pulse/.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map(file => path.relative(root, file));
  assert.deepEqual(offenders, [], `以下文件仍在使用 animate-pulse：${offenders.join(', ')}`);
});

test('状态点映射函数返回统一样式类', () => {
  const delegation = read('src/utils/asyncDelegation.ts');
  assert.match(delegation, /return 'bg-amber-400 lx-live-dot';/, 'subItemStatusDotClass 未收敛到统一样式类');
  const cards = read('src/utils/cardUi.ts');
  assert.match(cards, /return 'bg-amber-400 lx-live-dot';/, 'cardDotClass 未收敛到统一样式类');
});
