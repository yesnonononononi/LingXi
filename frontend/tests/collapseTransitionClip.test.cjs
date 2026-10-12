const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/components/common/CollapseTransition.vue'),
  'utf8'
);

/** 取出某个选择器的样式块；取不到返回 null（用于金丝雀对照）。 */
function ruleBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
  return match ? match[1] : null;
}

test('折叠动画的裁剪方式必须是 clip-path，不能建立 BFC', () => {
  // 金丝雀：先证明解析器确实能命中样式块，否则下面的断言在「选择器改名」时会假绿。
  for (const selector of ['.collapse-transition-enter-active', '.collapse-transition-leave-active']) {
    assert.notEqual(ruleBlock(selector), null, `未解析到 ${selector} 样式块，断言不成立`);
  }
});

for (const selector of ['.collapse-transition-enter-active', '.collapse-transition-leave-active']) {
  test(`${selector} 用 clip-path 裁剪且不写 overflow`, () => {
    const block = ruleBlock(selector);
    assert.match(block, /clip-path\s*:/, `${selector} 应使用 clip-path 裁剪溢出内容`);

    // overflow: hidden / clip 都会让折叠块在动画期间变成 BFC，块内子元素的上下 margin
    // 不再塌陷 —— onEnter 量到的 scrollHeight 比展开结束后的稳态高度多出这些 margin，
    // 动画收尾时高度回落，展开就是「先撑高再缩回」的弹跳。这里锁死不许回退。
    assert.doesNotMatch(
      block,
      /overflow\s*:/,
      `${selector} 不得写 overflow（会建立 BFC，导致折叠展开弹跳）`
    );
  });
}
