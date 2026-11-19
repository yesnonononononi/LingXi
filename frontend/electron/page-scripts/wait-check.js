/**
 * browser_wait 的页面侧单次探测：selector 可见与文本命中同时成立才算满足。
 */

let selectorOk = !args.rawSelector;
if (args.rawSelector) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(args.rawSelector));
  } catch {
    return {matched: false, url: window.location.href, title: document.title, error: '选择器不合法: ' + args.rawSelector};
  }
  selectorOk = nodes.some(lxIsVisible);
}

let textOk = !args.rawText;
if (args.rawText) {
  const bodyText = (document.body && document.body.innerText) || '';
  textOk = bodyText.includes(args.rawText);
}

return {matched: selectorOk && textOk, url: window.location.href, title: document.title};
