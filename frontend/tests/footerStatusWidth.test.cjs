const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 组尾底栏的状态块必须能被压缩。
 *
 * <p>真实缺陷：失败原因是一整条 `SSLEngine` 之类的异常串，而状态块是
 * `whitespace-nowrap` 的 flex 子项、又没写 `min-w-0` —— flex 的默认 `min-width:auto`
 * 让它按内容撑开，长串就把「用量 / 耗时 / 时间」挤到下一行，底栏看起来被吃掉了。
 * 所以这里钉两件事：状态块可收缩（min-w-0）、原因串自带 max-width。</p>
 *
 * <p>扫描范围：底栏内容已从 `ChatMessageItem.vue` 抽成独立组件 `MessageActionsBar.vue`
 * （插槽化试点，B 档），因此断言在两个文件里任一处命中即成立 —— 断言内容不变，
 * 只是让「搬家」不至于把这条护栏变成假红。选择器里的 `(?:props\.)?` 同理：
 * 抽成组件后模板里引用的是 props 前缀。</p>
 */
const SOURCES = [
  '../src/components/chat/ChatMessageItem.vue',
  '../src/components/chat/MessageActionsBar.vue',
].map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'));

function classOf(selectorPattern, where) {
  for (const source of SOURCES) {
    const match = new RegExp(selectorPattern + '[^>]*class="([^"]+)"').exec(source);
    if (match) return match[1];
  }
  assert.fail(`未解析到 ${where} 的 class，断言不成立（选择器变了？）`);
}

test('状态块可以收缩，原因串有 max-width，兄弟项不被挤走', () => {
  // 金丝雀：解析器必须真的命中，否则「没找到」会被当成「没问题」
  const status = classOf('<div v-if="(?:props\\.)?execStatusMeta"', '执行状态行');
  assert.match(status, /\bmin-w-0\b/, '状态行缺 min-w-0 ⇒ 长异常串会把底栏挤换行');
  assert.match(status, /\bflex-1\b/, '状态行仍需占满剩余空间，把用量/耗时推到右侧');

  const reason = classOf('<span\\s+v-if="(?:props\\.)?execStatusMeta\\.errorReason"', '失败原因');
  assert.match(reason, /\btruncate\b/, '失败原因必须截断');
  assert.match(reason, /max-w-\[[^\]]+\]/, '失败原因必须限宽（max-w-*），否则无限撑开');
  assert.match(reason, /\bmin-w-0\b/, '原因自身也要 min-w-0，否则 truncate 不生效');

  const duration = classOf('<div v-if="(?:props\\.)?showExecutionMeta"', '耗时块');
  assert.match(duration, /\bshrink-0\b/, '耗时块不得被压缩成半截');
  assert.doesNotMatch(duration, /\bflex-1\b/, '耗时块与状态行抢 flex-1 ⇒ 两侧都被拉薄');
});
