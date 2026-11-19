/**
 * browser_fill 的页面侧预处理：定位元素、滚动到位、聚焦并准备好插入位置。
 *
 *select 由本脚本直接改值并派发事件（原生输入通道对下拉无效）；其余元素只做
 * 选区准备，真正的文本写入由主进程走 insertText / CDP，保证 isTrusted。
 */

const located = lxLocateIndexed(args.rawRef, args.selector, args.index);
if (located.error) {
  return {ok: false, error: located.error, matchedCount: located.matchedCount};
}
const el = located.el;

el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
lxFlash(el, '输入');
if (typeof el.focus === 'function') el.focus();

if (el.tagName === 'SELECT') {
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
  if (args.submit && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
  return {ok: true, handled: true, ...lxDescribe(el)};
}

const isEmptyBefore = lxValueLength(el) === 0;
if (el.isContentEditable) {
  const range = document.createRange();
  range.selectNodeContents(el);
  if (!args.clear) range.collapse(false);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
} else if (args.clear) {
  if (typeof el.select === 'function') el.select();
  else if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, (el.value || '').length);
} else if (typeof el.setSelectionRange === 'function') {
  const length = (el.value || '').length;
  el.setSelectionRange(length, length);
}

return {ok: true, handled: false, isEmptyBefore};
