/**
 * browser_fill 的提交兜底：Enter 键盘事件 + form.requestSubmit。
 *
 *原生通道与脚本降级都走这一份，避免 `submit: true` 在两条路径下语义不同（旧缺陷）。
 */

const located = lxLocateIndexed(args.rawRef, args.selector, args.index);
if (located.error) return {ok: true, submitted: false, error: located.error};

const el = located.el;
const init = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true};
el.dispatchEvent(new KeyboardEvent('keydown', init));
el.dispatchEvent(new KeyboardEvent('keypress', init));
el.dispatchEvent(new KeyboardEvent('keyup', init));

const form = el.form || (typeof el.closest === 'function' ? el.closest('form') : null);
const submitted = Boolean(form && typeof form.requestSubmit === 'function');
if (submitted) form.requestSubmit();
return {ok: true, submitted};
