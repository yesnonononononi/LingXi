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
 * 5 个消费者必须把该工具类加在**承载列宽的那个元素**上，且不得再出现硬编码列宽
 * （`max-w-3xl` / `max-w-4xl` 这类命名宽度、`max-w-[48rem]` 这类字面量）。</p>
 *
 * <p>本文件用「元素级」断言而非整文件 `includes`：先把模板解析成元素开标签（剥掉 HTML 注释），
 * 再对每个消费者用锚定签名（令牌 + 该元素独有类名）定位列宽元素。整文件包含式断言会假绿 ——
 * 实测把 assistant 消息体容器的 `max-w-lx-chat` 挪到内层 div、容器换回 `max-w-4xl`，8 条用例
 * 曾全绿；锚定后同一变异由 C4/C5/C6 打红。所有「不存在」类断言都先做金丝雀正对照（C0），
 * 防止「检索式没生效还以为 0 处」的假绿（见 themeTokens.test.ts 的 T1-1）。</p>
 */

const STYLE_CSS = path.resolve(__dirname, '../src/style.css');

/**
 * 5 个消费者：文件路径 + 人类可读描述（描述只用于失败信息）+
 * 锚定签名（`anchor`）。
 *
 * <p>`anchor` 是「那个元素自己的 class 文本」必须匹配的正则：它把令牌和该元素独有的兄弟类名
 * 绑在同一条断言里。这样「类名在文件里存在、却没加在对话列容器上」（挪到内层 div、或只写进
 * 注释/其它元素）就会红 —— 只做整文件 `includes` 会放过这类假绿，已用变异实测过
 * （把 assistant 消息体容器的 max-w-lx-chat 挪到内层 div、容器改 max-w-4xl，整文件包含式
 * 断言仍全绿）。</p>
 *
 * <p>改动这些元素的 class 顺序/命名时同步更新锚定签名即可；故意写严一点，
 * 因为它守的是「宽度只有单一真源 + 消费位置不可漂移」这条契约。</p>
 */
const CONSUMERS = [
  {
    rel: '../src/components/chat/ChatMessageList.vue',
    label: '消息列表容器',
    // :class="['flex-1 w-full space-y-3', compact ? 'px-3.5 py-4' : 'max-w-lx-chat mx-auto py-6 px-4']"
    anchor: /max-w-lx-chat\s+mx-auto\s+py-6\s+px-4/,
  },
  {
    rel: '../src/components/chat/ChatInputArea.vue',
    label: '输入区容器',
    // class="w-full max-w-lx-chat mx-auto px-4 select-none"
    anchor: /w-full\s+max-w-lx-chat\s+mx-auto\s+px-4\s+select-none/,
  },
  {
    rel: '../src/components/chat/ChatMessageItem.vue',
    label: 'assistant 消息体',
    // class="flex flex-col items-start w-full max-w-lx-chat space-y-2.5"
    anchor: /flex-col\s+items-start\s+w-full\s+max-w-lx-chat/,
  },
  {
    rel: '../src/components/chat/ChatExecutionControls.vue',
    label: '执行控制条',
    // class="w-full max-w-lx-chat px-4 mb-2 text-xs"
    anchor: /w-full\s+max-w-lx-chat\s+px-4\s+mb-2/,
  },
  {
    rel: '../src/components/chat/BackgroundTaskPanel.vue',
    label: '后台任务面板',
    // class="background-tasks w-full max-w-lx-chat mx-auto px-4"
    anchor: /background-tasks\s+w-full\s+max-w-lx-chat\s+mx-auto\s+px-4/,
  },
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

/** 剥掉 HTML 注释：注释里写类名不算「消费了令牌」（防注释式假绿） */
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 扫描模板里的「元素开标签」。
 *
 * <p>逐字符扫描并跟踪引号状态，保证属性值里出现的 `>`（如 `v-if="a > b"`）不会被当成标签结束。
 * 只返回 `<tag ...>` 这一段文本，调用方再用 {@link classTextOfTag} 取 class 属性值。</p>
 */
function scanElementTags(source) {
  const clean = stripHtmlComments(source);
  const tags = [];
  let index = 0;
  while (index < clean.length) {
    const lt = clean.indexOf('<', index);
    if (lt === -1) break;
    // `<` 后面紧跟字母才算开标签（排除 </div>、<= 之类）
    if (!/[a-zA-Z]/.test(clean[lt + 1] || '')) {
      index = lt + 1;
      continue;
    }
    let cursor = lt + 1;
    let quote = null;
    while (cursor < clean.length) {
      const ch = clean[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= clean.length) break;
    tags.push(clean.slice(lt, cursor + 1));
    index = cursor + 1;
  }
  return tags;
}

/** 取一个元素开标签上 class / :class 属性值的拼接文本（静态与动态绑定都算） */
function classTextOfTag(tag) {
  const parts = [];
  const re = /\s(?:v-bind:)?:?class\s*=\s*(["'])([\s\S]*?)\1/g;
  let match = re.exec(tag);
  while (match !== null) {
    parts.push(match[2]);
    match = re.exec(tag);
  }
  return parts.join(' ');
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

  // 元素扫描器金丝雀：注释里的类名必须被剥离；属性值里的 > 不能截断标签
  const sampleTags = scanElementTags(
    `<div :class="n > 0 ? 'max-w-lx-chat mx-auto py-6 px-4' : 'px-3'" data-note='a>b'>x</div>` +
      `<!-- data-comment max-w-lx-chat -->`
  );
  assert.equal(sampleTags.length, 1, `扫描器必须只认真正的元素开标签，实际抓到 ${sampleTags.length} 个`);
  assert.match(
    classTextOfTag(sampleTags[0]),
    /max-w-lx-chat/,
    'class 绑定值（含三元表达式）必须被完整取出，否则锚定断言会假红'
  );
  assert.doesNotMatch(
    sampleTags.join(''),
    /data-comment/,
    '注释必须已被剥离，否则注释里的类名会冒充「元素上真的用了令牌」'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 断言 A：固定适度收窄后的列宽，避免输入框再次铺得过宽
// ─────────────────────────────────────────────────────────────────────────────

test('C1 @theme inline 里的 --container-lx-chat 为 56rem', () => {
  const themeBody = extractBlock(styleCss, '@theme inline');
  const rem = parseChatColumnRem(themeBody);
  assert.notEqual(rem, null, 'src/style.css 的 @theme inline 里必须有 --container-lx-chat: <数值>rem');
  assert.equal(rem, 56, '对话列宽应保持 56rem，让输入框适度收窄');
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

test('C4 五个对话列容器都把 max-w-lx-chat 加在「承载列宽的那个元素」上', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    const matched = scanElementTags(consumer.source).filter((tag) =>
      consumer.anchor.test(classTextOfTag(tag))
    );
    if (matched.length === 0) {
      problems.push(
        `${consumer.label}（${path.basename(consumer.rel)}）没有任何元素同时命中锚定签名 ` +
          `${consumer.anchor}：令牌可能被挪到别的元素/注释里，或该元素被换成了硬编码宽度`
      );
    }
  }
  assert.deepEqual(problems, [], '以下容器没有在对话列元素上消费列宽单一真源');
});

test('C5 列宽元素上不得叠加其它 max-w 宽度，且必须保留 w-full/flex-1 撑满语义', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    const columnTags = scanElementTags(consumer.source).filter((tag) =>
      classTextOfTag(tag).includes('max-w-lx-chat')
    );
    if (columnTags.length === 0) {
      problems.push(`${consumer.label} 没有任何元素消费 max-w-lx-chat`);
      continue;
    }
    for (const tag of columnTags) {
      const classText = classTextOfTag(tag);
      const extraWidths = collectMaxWidthUtilities(classText).filter(
        (cls) => !cls.endsWith('max-w-lx-chat')
      );
      if (extraWidths.length > 0) {
        problems.push(
          `${consumer.label} 的列宽元素上还叠加了 ${extraWidths.join(', ')}，宽度不再是单一真源`
        );
      }
      if (!/\bw-full\b|\bflex-1\b/.test(classText)) {
        problems.push(
          `${consumer.label} 的列宽元素缺 w-full/flex-1，列宽不会被撑满，会与输入区左右不对齐`
        );
      }
    }
  }
  assert.deepEqual(problems, [], '列宽单一真源或对齐语义被破坏');
});

test('C6 五个文件里不得再出现硬编码列宽（max-w-3xl / max-w-[48rem] 这类写回具体宽度）', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    const clean = stripHtmlComments(consumer.source);
    const hits = [
      ...clean.matchAll(/max-w-(?:3xl|4xl|5xl|6xl|7xl)\b|max-w-\[\s*[0-9]+(?:\.[0-9]+)?rem\s*\]/g),
    ].map((match) => match[0]);
    if (hits.length > 0) {
      problems.push(`${consumer.label}（${path.basename(consumer.rel)}）仍在使用 ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(problems, [], '列宽必须只有单一真源，以下位置把宽度写回去了');
});

// ─────────────────────────────────────────────────────────────────────────────
// 断言 C：反面对照 —— 5 个文件里不得再出现 max-w-3xl
// ─────────────────────────────────────────────────────────────────────────────

test('C8 令牌类名只能挂在元素 class 上（写进注释/纯文本不算消费）', () => {
  const problems = [];
  for (const consumer of CONSUMERS) {
    const clean = stripHtmlComments(consumer.source);
    const occurrences = (clean.match(/max-w-lx-chat/g) || []).length;
    const onElements = scanElementTags(consumer.source).filter((tag) =>
      classTextOfTag(tag).includes('max-w-lx-chat')
    ).length;
    if (occurrences !== onElements) {
      problems.push(
        `${consumer.label}：max-w-lx-chat 出现 ${occurrences} 次，但只有 ${onElements} 处在元素 class 上` +
          `（其余出现在注释以外的文本里，不构成对令牌的消费）`
      );
    }
  }
  assert.deepEqual(problems, [], '令牌类名必须真的挂在元素 class 上');
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
