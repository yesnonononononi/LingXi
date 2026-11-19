/**
 * browser_fill 的页面侧回读：确认文本真的写进去了（insertText 在面板失焦时可能被吞）。
 */

const located = lxLocateIndexed(args.rawRef, args.selector, args.index);
if (located.error) {
  return {ok: false, error: located.error, matchedCount: located.matchedCount};
}
return {ok: true, ...lxDescribe(located.el)};
