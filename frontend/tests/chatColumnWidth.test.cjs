const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 对话列宽的「单一真源」护栏。
 *
 * <p>真实缺陷：中间消息列原本在 5 个组件里各自写死 `max-w-3xl`（48rem）。只改其中一两处，
 * 消息列表 / 输入框 / 执行控制条 / 后台任务面板就会左右不对齐。</p>
 *
 * <p>现在的契约：宽度只定义一次 —— `src/style.css` 的 `@theme inline` 里的
 * `--container-lx-chat`，Tailwind v4 由该令牌自动生成 `max-w-lx-chat` 工具类；
 * 5 个消费者必须全部消费这个工具类，且不得再出现硬编码的 `max-w-3xl`。</p>
 *
 * <p>本文件是纯文本断言（readFileSync + 正则），不挂载组件，风格对齐
 * `tests/footerStatusWidth.test.cjs`。所有「不存在」类断言都先做金丝雀正对照，
 * 防止「检索式没生效还以为 0 处」的假绿（见 themeTokens.test.ts 的 T1-1）。</p>
 */

const STYLE_CSS = path.resolve(__dirname, '../src/style.css');

/** 5 个消费者：文件路径 + 人类可读描述（描述只用于失败信息） */
const CONSUMERS = [
  { rel: '../src/components/chat/ChatMessageList.vue', label: '消息列表容器' },
  { rel: '../src/components/chat/ChatInputArea.vue', label: '输入区容器' },
  { rel: '../src/components/chat/ChatMessageItem.vue', label: 'assistant 消息体' },
  { rel: '../src/components/chat/ChatExecutionControls.vue', label: '执行控制条' },
  { rel: '../src/components/chat/BackgroundTaskPanel.vue', label: '后台任务面板' },
].map((item) => ({
  ...item,
  source: fs.readFileSync(path.resolve(__dirname, item.rel), 'utf8'),
}));

/** 剥掉 CSS 注释：注释里也会出现令牌字样的说明文字，不剥会误判 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取出某个选择器块的正文（块内无嵌套花括号，简单配对即可） */
function extractBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `未找到选择器块：${selector}`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `选择器 ${selector} 后没有 {`);
  const close = css.indexOf('}', open);
  assert.notEqual(close, -1, `选择器 ${selector} 的块没有闭合`);
  return css.slice(open + 1, close);
}

/** 从 @theme 块里解析容器宽度令牌（单位 rem），未定义返回 null */
function parseChatColumnRem(themeBody) {
  const match = /--container-lx-chat\s*:\s*([0-9]+(?:\.[0-9]+)?)rem\s*;/.exec(themeBody);
  return match ? Number(match[1]) : null;
}

/** 某段文本里出现的 `max-w-<name>` 工具类名（含任意变体前缀，如 sm:max-w-2xl） */
function collectMaxWidthUtilities(text) {
  const found = [];
  const re = /(?:[a-z0-9-]+:)*max-w-(?:\[[^"'\s]+\]|[a-z0-9-.]+)/g;
  let match = re.exec(text);
  while (match !== null) {
    found.push(match[0]);
    match = re.exec(text);
  }
  return found;
}

const styleCss = stripCssComments(fs.readFileSync(STYLE_CSS, 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
// 金丝雀：先证明解析器与检索式本身能命中
// ─────────────────────────────────────────────────────────────────────────────

test('C0 金丝雀：解析器能从合成样本里抓到容器令牌与 max-w 工具类', () => {
  const sampleTheme = extractBlock('@theme inline {\n  --container-lx-chat: 64rem;\n}', '@theme inline');
  assert.equal(parseChatColumnRem(sampleTheme), 64, '令牌解析器必须能命中合成样本');

  const sampleClass = '<div class="flex w-full max-w-3xl mx-auto"></div>';
  assert.deepEqual(
    collectMaxWidthUtilities(sampleClass),
    ['max-w-3xl'],
    'max-w 工具类解析器必须能命中合成样本（否则「不再出现 max-w-3xl」会是假绿）'
  );

  const samplePrefixed = '<div class="sm:max-w-2xl"></div>';
  assert.deepEqual(collectMaxWidthUtilities(samplePrefixed), ['sm:max-w-2xl'], '变体前缀也必须被识别');
});

// ─────────────────────────────────────────────────────────────────────────────
// 断言 A：宽度令牌存在且确实「加宽」了（>= 60rem，原 48rem）
// ─────────────────────────────────────────────────────────────────────────────

test('C1 @theme inline 里的 --container-lx-chat 存在且不小于 60rem', () => {
  const themeBody = extractBlock(styleCss, '@theme inline');
  const rem = parseChatColumnRem(themeBody);
  assert.notEqual(rem, null, 'src/style.css 的 @theme inline 里必须有 --container-lx-chat: <数值>rem');
  assert.ok(rem >= 60, `对话列宽令牌不得被改窄：期望 >= 60rem，实际 ${rem}rem`);
});

test('C2 令牌是字面量宽度，不得引入 var() 引用（布局宽度不属于主题包令牌）', () => {
  const themeBody = extractBlock(styleCss, '@theme inline');
  const line = /--container-lx-chat\s*:[^;]*;/.exec(themeBody);
  assert.notEqual(line, null, '未解析到 --container-lx-chat 声明行');
  assert.doesNotMatch(line[0], /var\(/, '--container-lx-chat 必须是字面量 rem，不能引用主题变量');
});

test('C3 布局宽度令牌不得混进 theme/tokens.css 与 theme/tokens.ts', () => {
  const tokensCss = fs.readFileSync(path.resolve(__dirname, '../src/theme/tokens.css'), 'utf8');
  const tokensTs = fs.readFileSync(path.resolve(__dirname, '../src/theme/tokens.ts'), 'utf8');
  assert.doesNotMatch(tokensCss, /container-lx-chat/, 'tokens.css 只管颜色/形态令牌，布局宽度不应进入');
  assert.doesNotMatch(tokensTs, /container-lx-chat/, 'tokens.ts 只管颜色/形态令牌，布局宽度不应进入');
});

// ─────────────────────────────────────────────────────────────────────────────
// 断言 B：5 个消费者全部消费 max-w-lx-chat
// ─────────────────────────────────────────────────────────────────────────────

test('C4 五个对话列容器都消费 max-w-lx-chat', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    if (!consumer.source.includes('max-w-lx-chat')) {
      problems.push(`${consumer.label}（${path.basename(consumer.rel)}）未消费 max-w-lx-chat`);
    }
  }
  assert.deepEqual(problems, [], '以下容器没有走列宽单一真源');
});

test('C5 五个对话列容器都保留了原有的对齐语义', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    if (!/\bw-full\b|\bflex-1\b/.test(consumer.source)) {
      problems.push(`${consumer.label} 缺 w-full/flex-1，列宽不会被撑满`);
    }
  }
  assert.deepEqual(problems, [], '对齐语义被破坏');
});

// ─────────────────────────────────────────────────────────────────────────────
// 断言 C：反面对照 —— 5 个文件里不得再出现 max-w-3xl
// ─────────────────────────────────────────────────────────────────────────────

test('C6 五个文件里不得再出现硬编码的 max-w-3xl', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    const hits = collectMaxWidthUtilities(consumer.source).filter((cls) => cls.endsWith('max-w-3xl'));
    if (hits.length > 0) {
      problems.push(`${consumer.label}（${path.basename(consumer.rel)}）仍在使用 ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(problems, [], '列宽必须只有单一真源，以下位置把宽度写回去了');
});

test('C7 用户气泡自身的 sm:max-w-2xl 不受影响（不在本次范围内，防止顺手改坏）', () => {
  const item = CONSUMERS.find((consumer) => consumer.rel.endsWith('ChatMessageItem.vue'));
  assert.ok(item, '未找到 ChatMessageItem.vue 消费者');
  assert.match(
    collectMaxWidthUtilities(item.source).join(' '),
    /sm:max-w-2xl/,
    '用户气泡的 sm:max-w-2xl 属于气泡自身上限，不应被列宽改造波及'
  );
});
