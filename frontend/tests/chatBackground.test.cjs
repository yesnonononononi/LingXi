/**
 * 主页背景层抽取契约（插件化第一层）。
 *
 * 锁四件事：
 * 1. 背景层已从 ChatView 抽出 —— 旧的三元写法必须彻底消失，否则抽取只是复制粘贴；
 * 2. 背景层完全由 CSS 变量驱动 —— 一旦出现 isDark / v-if 主题分支，就多出第四条主题通道，
 *    与 useTheme 的 dataset/class 双写不同源，必然出现「切了主题背景不跟」的静默失配；
 * 3. 图层必须能点穿（pointer-events）+ 对辅助技术隐身（aria-hidden），否则会挡住下层交互；
 * 4. 两个新光晕令牌在暗/亮两套作用域里都有定义，且亮色为 transparent
 *    ——少一边就会在亮色主题下留一块淡色污渍。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/** 剥掉注释：文件头注释里也会出现选择器/令牌字样，不剥会把注释当成真代码（本项目踩过同类假绿）。 */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

const chatView = stripComments(read('src/views/chat/ChatView.vue'));
const background = read('src/components/chat/ChatBackground.vue');
const tokensCss = stripComments(read('src/theme/tokens.css'));

/** 取出某个选择器（或其内部 needle）之后的规则块正文；块内无嵌套花括号，简单配对即可。 */
function blockAfter(source, needle) {
  const start = source.indexOf(needle);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  const close = source.indexOf('}', open);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

/** 取某个令牌在给定块里的取值（去空白）；取不到返回 null。 */
function tokenValue(block, token) {
  if (block === null) return null;
  const match = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
}

const darkBlock = blockAfter(tokensCss, ':root {');
const lightBlock = blockAfter(tokensCss, 'html[data-theme="light"]');

test('金丝雀：块解析器能命中暗/亮两套作用域（否则后面的断言全部空转）', () => {
  assert.notEqual(darkBlock, null, '未解析到 :root 块');
  assert.notEqual(lightBlock, null, '未解析到 html[data-theme="light"] 块');
  assert.equal(tokenValue(darkBlock, '--lx-canvas'), '#000000', '暗色画布取值应与既有令牌一致');
  assert.equal(tokenValue(lightBlock, '--lx-canvas'), '#ffffff', '亮色画布取值应与既有令牌一致');
});

test('ChatView 已不再内联背景层，改为渲染 ChatBackground 组件', () => {
  assert.doesNotMatch(chatView, /absolute inset-0 bg-black/, '背景层旧写法（暗色内联 div）仍在 ChatView 里');
  assert.doesNotMatch(chatView, /absolute inset-0 bg-white/, '背景层旧写法（亮色内联 div）仍在 ChatView 里');
  assert.doesNotMatch(chatView, /from-blue-500\/\[0\.035\]/, '光晕色仍硬编码在视图里，抽取不彻底');
  assert.match(chatView, /<ChatBackground\s*\/>/, 'ChatView 模板里必须渲染 <ChatBackground />');
  assert.match(chatView, /import ChatBackground from '\.\.\/\.\.\/components\/chat\/ChatBackground\.vue';/,
    'ChatBackground 组件未正确导入');
});

test('背景层底色与插件背景图都走 CSS 变量', () => {
  assert.match(background, /background-color:\s*var\(--lx-canvas\)/,
    '底色必须取 var(--lx-canvas)，写死色值会让亮色主题仍是黑底');
  assert.match(background, /var\(--lx-canvas-image, none\)/,
    '缺少 background-image: var(--lx-canvas-image, none) 插件扩展点');
  assert.match(background, /background-size:\s*cover/, '背景图扩展点缺少 background-size: cover');
  assert.match(background, /background-position:\s*center/, '背景图扩展点缺少 background-position: center');
  assert.match(background, /background-repeat:\s*no-repeat/, '背景图扩展点缺少 background-repeat: no-repeat');
});

test('背景层保留点穿与无障碍语义', () => {
  assert.match(background, /pointer-events-none|pointer-events:\s*none/, '背景层必须能点穿，否则挡住下层交互');
  assert.match(background, /aria-hidden="true"/, '纯装饰图层必须对辅助技术隐身');
  assert.match(background, /absolute inset-0 z-0 overflow-hidden/, '必须保留原来的图层定位语义（z-0 / inset-0）');
});

test('背景层不得自带主题判断（禁止第四条主题通道）', () => {
  assert.doesNotMatch(background, /isDark/, 'ChatBackground 不得读 isDark，明暗只能由 CSS 变量承担');
  assert.doesNotMatch(background, /displayIsDark/, 'ChatBackground 不得读 displayIsDark');
  assert.doesNotMatch(background, /\bv-if\b/, 'ChatBackground 不得用 v-if 按主题分支渲染');
  assert.doesNotMatch(background, /blue-500|indigo-500/, '光晕色不得再硬编码 Tailwind 色阶');
  assert.doesNotMatch(background, /defineProps/, 'ChatBackground 必须无 props');
});

test('光晕令牌在暗/亮两套作用域都有定义，且亮色为 transparent', () => {
  for (const token of ['--lx-canvas-glow-from', '--lx-canvas-glow-via']) {
    assert.equal(tokenValue(darkBlock, token), token === '--lx-canvas-glow-from'
      ? 'rgba(59, 130, 246, 0.035)'
      : 'rgba(99, 102, 241, 0.015)', `${token} 暗色取值不符（或未定义）`);
    assert.equal(tokenValue(lightBlock, token), 'transparent', `${token} 亮色必须取 transparent，否则亮色底下留一块淡色污渍`);
  }
});
