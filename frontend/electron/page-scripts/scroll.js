/**
 * browser_scroll 的页面侧实现：整页或指定容器按方向滚动，并回报是否触底。
 */

const target = args.selector ? document.querySelector(args.selector) : null;
if (args.selector && !target) return {ok: false, error: '未找到滚动目标元素: ' + args.selector};

if (target && !args.px && args.direction === 'down') {
  // 给了容器但没给步长：把容器滚到视口中间，这是「滚到这里」的直觉语义
  target.scrollIntoView({block: 'center', behavior: 'instant'});
} else {
  const step = args.px || Math.round(window.innerHeight * 0.8);
  const container = target || document.scrollingElement || document.documentElement;
  if (args.direction === 'top') container.scrollTop = 0;
  else if (args.direction === 'bottom') container.scrollTop = container.scrollHeight;
  else if (args.direction === 'up') container.scrollTop = Math.max(0, container.scrollTop - step);
  else container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + step);
}

const root = target || document.scrollingElement || document.documentElement;
return {
  ok: true,
  scrollTop: Math.round(root.scrollTop),
  scrollHeight: Math.round(root.scrollHeight),
  clientHeight: Math.round(root.clientHeight),
  atBottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 2,
  url: window.location.href,
  title: document.title,
};
