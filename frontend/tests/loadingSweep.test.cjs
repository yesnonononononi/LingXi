/**
 * 过程段加载态（扫光）样式契约。
 *
 * 锁三件事：
 * 1. 样式独立成层且被真正引入 —— 没被 @import 的规则等于没写，组件看着"挂了类"其实静默失效。
 * 2. 配色只走主题令牌 —— 一旦写死 #fff，亮色主题下文字会变成透明（background-clip: text + 浅底白字）。
 * 3. 业务组件不再自带呼吸点、也不在 script 里拼样式字面量。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const css = read('src/styles/loading-sweep.css');
const styleEntry = read('src/style.css');
const tokens = read('src/theme/tokens.css');
const segment = read('src/components/chat/ChatProcessSegment.vue');

/** 取出某个选择器的样式块；取不到返回 null（用于金丝雀对照）。 */
function ruleBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
  return match ? match[1] : null;
}

test('扫光样式必须被入口样式表引入', () => {
  assert.match(styleEntry, /@import\s+"\.\/styles\/loading-sweep\.css";/,
    'style.css 未引入 loading-sweep.css，组件挂了类也不会有效果');
});

test('扫光类用渐变裁切文字并驱动动画', () => {
  const block = ruleBlock(css, '.lx-sweep-text');
  assert.notEqual(block, null, '未解析到 .lx-sweep-text 样式块，后续断言不成立');
  assert.match(css, /@keyframes\s+lx-sweep-text-shift\s*\{/, '缺少扫光关键帧');
  // 不能写成 /background-clip:\s*text/：它会命中 "-webkit-background-clip: text" 造成假绿。
  assert.match(block, /[\s;{]background-clip:\s*text/, '必须裁切到文字，否则是一块色带糊在字上');
  assert.match(block, /-webkit-background-clip:\s*text/, 'Electron/Chromium 需要 -webkit 前缀');
  assert.match(block, /color:\s*transparent/, '文字本体必须透明，让渐变透出来');
  assert.match(block, /animation:\s*lx-sweep-text-shift/, '样式块必须引用扫光关键帧');
});

test('配色只走主题令牌，不写死颜色', () => {
  const block = ruleBlock(css, '.lx-sweep-text');
  assert.match(block, /var\(--lx-text-muted\)/, '常态色应取 --lx-text-muted');
  assert.match(block, /var\(--lx-text-primary\)/, '高光色应取当前主题的最高对比前景色');
  // color: transparent 之下，写死浅色的高光在亮色主题会让文字半透明消失。
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, '样式块里不允许出现硬编码色值');
  assert.doesNotMatch(block, /rgba?\(/, '样式块里不允许出现硬编码色值');
});

test('两个主题都定义了扫光用到的令牌', () => {
  for (const token of ['--lx-text-muted', '--lx-text-primary']) {
    const hits = tokens.split(`${token}:`).length - 1;
    assert.equal(hits, 2, `${token} 应在暗色与亮色两套主题各定义一次，实际 ${hits} 次`);
  }
});

test('减弱动态效果时退回普通文字色', () => {
  const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/.exec(css);
  assert.notEqual(media, null, '缺少 prefers-reduced-motion 降级块');
  const block = ruleBlock(media[0], '.lx-sweep-text');
  assert.notEqual(block, null, '降级块里没有 .lx-sweep-text');
  assert.match(block, /animation:\s*none/, '降级时必须停掉动画');
  assert.match(block, /background-image:\s*none/, '降级时不应留下静止的半亮渐变');
  assert.match(block, /color:\s*inherit/, '降级时文字要回到父级颜色，否则仍是透明');
});

test('过程摘要只在可汇总时渲染，运行过程保留独立呈现模式', () => {
  assert.match(segment, /<button v-if="canSummarize"/, '摘要入口必须受可汇总判据约束');
  assert.match(segment, /:data-process-mode="canSummarize \? 'summary' : 'live'"/);
  assert.doesNotMatch(segment, /animate-pulse/, '呼吸点与扫光是两个互相打架的加载信号，只留一个');
  assert.doesNotMatch(segment, /rounded-full bg-current/, '呼吸点被删干净');
});

test('样式不落进业务脚本：script setup 里不出现扫光类名', () => {
  const script = /<script setup lang="ts">([\s\S]*?)<\/script>/.exec(segment);
  assert.notEqual(script, null, '未解析到 script setup 段，断言不成立');
  assert.doesNotMatch(script[1], /lx-sweep/, '样式类名只应出现在模板里，不该在脚本里拼');
});
