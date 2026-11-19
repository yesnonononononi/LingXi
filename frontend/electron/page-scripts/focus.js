/**
 * browser_press_key 的页面侧前置：把焦点放到目标元素上。
 */

const located = lxLocate(args.rawRef, args.rawSelector);
if (located.error) return {ok: false, error: located.error};
const el = located.el;
el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
lxFlash(el, '输入');
if (typeof el.focus === 'function') el.focus();
return {ok: true, tag: el.tagName.toLowerCase()};
