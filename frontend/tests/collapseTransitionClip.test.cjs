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

test('enter-active 用 clip-path 裁剪且不写 overflow', () => {
  const block = ruleBlock('.collapse-transition-enter-active');
  assert.match(block, /clip-path\s*:/, '.collapse-transition-enter-active 应使用 clip-path 裁剪溢出内容');

  // overflow: hidden 会让折叠块在动画期间变成 BFC，块内子元素的上下 margin 不再塌陷：
  // onEnter 量到的 scrollHeight 比展开结束后的稳态高度多出这些 margin（实测 16px），
  // 动画收尾时高度回落，展开就是「先撑高再缩回」的弹跳。enter 的测量发生在 enter-active
  // 类生效期间，任何 overflow 都会污染测量，这里锁死不许回退。
  assert.doesNotMatch(
    block,
    /overflow\s*:/,
    '.collapse-transition-enter-active 不得写 overflow（会建立 BFC，导致折叠展开弹跳）'
  );
});

test('leave-active 必须 overflow: clip 兜住子树溢出', () => {
  const block = ruleBlock('.collapse-transition-leave-active');
  assert.match(block, /clip-path\s*:/, '.collapse-transition-leave-active 应使用 clip-path 裁剪溢出内容');

  // 只靠 clip-path 时，leave 动画把元素高度缩到 0，子树仍是自然高度且继续参与祖先的
  // scrollHeight 计算；Transition 结束摘掉元素的那一刻这份溢出瞬间消失（实测单帧 128px），
  // 吸底逻辑同帧拽 scrollTop，整条消息列表「瞬一下」。overflow: clip 把子树挡进元素的
  // 溢出裁剪区，scrollHeight 随动画平滑下降，摘元素时不再突降。
  assert.match(
    block,
    /overflow\s*:\s*clip\b/,
    '.collapse-transition-leave-active 必须写 overflow: clip，兜住子树溢出（否则收束结束会掉 scrollHeight）'
  );

  // hidden 同样能兜住溢出，但会建 BFC：块内 margin 不再塌陷（实测内部溢出 244→252px），
  // 收起开始时内容先位移、底部还被裁掉一截。clip 不建 BFC，实测与不写 overflow 完全一致。
  assert.doesNotMatch(
    block,
    /overflow\s*:\s*(?:hidden|scroll|auto)\b/,
    '.collapse-transition-leave-active 只能用 overflow: clip；hidden/scroll/auto 会建立 BFC'
  );
});
