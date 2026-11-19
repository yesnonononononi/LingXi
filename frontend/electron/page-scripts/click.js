/**
 * browser_click 的页面侧实现：按 ref / selector / text 定位，点击或仅悬停。
 *
 *真实点击走 el.click()，悬停额外由主进程补发原生 mouseMove —— 合成 mouseover
 * 骗不过 CSS :hover。
 */

let el = null;
let matchedNodes = [];
let visibleNodes = [];

if (args.rawRef) {
  const located = lxLocate(args.rawRef, '');
  if (located.error) return {ok: false, error: located.error, matchedCount: 0, visibleCount: 0};
  el = located.el;
  matchedNodes = [el];
  visibleNodes = [el];
} else {
  const baseSelector = args.rawSelector || args.defaultClickSelector;
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(baseSelector));
  } catch {
    return {ok: false, error: '选择器不合法: ' + baseSelector, matchedCount: 0, visibleCount: 0};
  }
  if (args.rawText) {
    const needle = args.rawText.toLowerCase();
    nodes = nodes.filter(node => {
      const label = (node.innerText || node.textContent || node.getAttribute('aria-label') || node.value || '');
      return lxNormalizeText(label).toLowerCase().includes(needle);
    });
  }
  const picked = lxPickIndexed(nodes, args.targetIndex);
  matchedNodes = nodes;
  visibleNodes = nodes.filter(lxIsVisible);
  el = picked.el;
  if (!el) {
    const hint = args.rawSelector || args.rawText;
    return {
      ok: false,
      error: '未找到匹配元素: ' + hint + '（命中 ' + nodes.length + ' 个，可见 ' + visibleNodes.length + ' 个）。'
        + '可用 browser_query 查看当前页面的 selectorHint',
      matchedCount: nodes.length,
      visibleCount: visibleNodes.length,
    };
  }
}

el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
lxFlash(el, args.hoverOnly ? '悬停' : '点击');
const center = lxCenter(el);

if (args.hoverOnly) {
  el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, cancelable: true, clientX: center.x, clientY: center.y}));
  el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false, cancelable: false, clientX: center.x, clientY: center.y}));
} else {
  if (typeof el.focus === 'function') el.focus();
  el.click();
}

return {
  ok: true,
  hoverOnly: args.hoverOnly,
  centerX: center.x,
  centerY: center.y,
  matchedCount: matchedNodes.length,
  visibleCount: visibleNodes.length,
  tag: el.tagName.toLowerCase(),
  id: el.id || '',
  className: typeof el.className === 'string' ? el.className : '',
  text: lxNormalizeText(el.innerText || el.textContent).slice(0, 120),
  currentUrl: window.location.href,
  currentTitle: document.title,
};
