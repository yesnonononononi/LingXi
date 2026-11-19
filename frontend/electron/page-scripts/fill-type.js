/**
 * browser_fill 的兜底写值：没有原生输入通道时直接改值并派发 input/change。
 *
 *只在前端拿不到 insertText 时使用——合成事件会被 React 受控组件忽略，
 * 这是已知的降级路径，不是首选。
 */

const located = lxLocateIndexed(args.rawRef, args.selector, args.index);
if (located.error) {
  return {ok: false, error: located.error, matchedCount: located.matchedCount};
}
const el = located.el;
el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
lxFlash(el, '输入');
if (typeof el.focus === 'function') el.focus();

if (el.isContentEditable) {
  el.textContent = args.clear ? args.textValue : ((el.textContent || '') + args.textValue);
  el.dispatchEvent(new InputEvent('input', {bubbles: true, data: args.textValue, inputType: 'insertText'}));
} else if (el.tagName === 'SELECT') {
  const options = Array.from(el.options || []);
  const byValue = options.find(option => option.value === args.textValue);
  const byText = byValue
    || options.find(option => lxNormalizeText(option.textContent) === args.textValue)
    || options.find(option => lxNormalizeText(option.textContent).includes(args.textValue));
  const resolved = byText ? byText.value : args.textValue;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, resolved);
  else el.value = resolved;
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
} else {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const finalValue = args.clear ? args.textValue : ((el.value || '') + args.textValue);
  if (descriptor && descriptor.set) descriptor.set.call(el, finalValue);
  else el.value = finalValue;
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
}

return {ok: true, ...lxDescribe(el)};
