/**
 * 多题选择卡的顺序状态机（纯函数，无 Vue 依赖）。
 *
 * <p>为什么单独抽出来：落点与进位原本是组件里的两处数组下标算术
 * （`entries[0]` 与 `activeIndex + 1`），它们隐含了"数组顺序恰好等于作答顺序、
 * 且所有题都还没答"这个从未被声明过的前提。一旦前面有已答的题、或条目顺序
 * 与作答顺序不一致，卡片就会停在一道不该成为落点的题上。这里把「谁该是落点」
 * 收敛成两个可枚举的函数，组件只负责把状态喂进来。</p>
 */

/**
 * 选出组内默认落点：**第一道还没答的题**。
 *
 * <p>「还没答」= 卡片未 completed 且没有草稿答案。历史里已答过的题不能当落点，
 * 否则用户打开卡片就停在一道已经答完的题上，还要自己往回翻。</p>
 *
 * @param answered 逐题作答状态，顺序须与组内条目一致
 * @returns 落点下标；全部答完时返回第一题（供回看修改），空组返回 -1
 */
export function firstUnansweredIndex(answered: readonly boolean[]): number {
  if (answered.length === 0) return -1;
  const index = answered.findIndex(done => !done);
  return index === -1 ? 0 : index;
}

/**
 * 选出「答完当前题之后该去哪」：**后面第一道还没答的题**，绝不回绕。
 *
 * <p>两个刻意的边界：</p>
 * <ul>
 *   <li>不跳过前面没答的题去凑后面——顺序作答是本组唯一的语义，<b>跳过等于让用户漏答</b>；</li>
 *   <li>当前位之后没有未答的题时返回 -1，由调用方保持原位（末题不进位，也不绕回第一题）。</li>
 * </ul>
 *
 * @param answered 逐题作答状态，顺序须与组内条目一致
 * @param from     当前题下标；非法值（-1 / 非整数 / 越界）按「从头找」处理
 * @returns 下一道未答题的下标；没有则返回 -1
 */
export function nextUnansweredIndex(answered: readonly boolean[], from: number): number {
  const start = Number.isInteger(from) && from > -1 ? from + 1 : 0;
  for (let index = start; index < answered.length; index += 1) {
    if (!answered[index]) return index;
  }
  return -1;
}
