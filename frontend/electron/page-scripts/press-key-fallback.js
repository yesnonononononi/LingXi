/**
 * 没有原生输入通道时的按键兜底：在焦点元素上派发 KeyboardEvent。
 */

const init = {
  key: args.key,
  bubbles: true,
  cancelable: true,
  ctrlKey: args.modifiers.includes('control'),
  shiftKey: args.modifiers.includes('shift'),
  altKey: args.modifiers.includes('alt'),
  metaKey: args.modifiers.includes('meta'),
};
const target = document.activeElement || document.body || document.documentElement;
target.dispatchEvent(new KeyboardEvent('keydown', init));
target.dispatchEvent(new KeyboardEvent('keyup', init));
return {ok: true, url: window.location.href, title: document.title};
