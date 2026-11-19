/**
 * browser_evaluate 的页面侧实现。
 *
 *编译和运行分成两步：`new Function('return (...)')` 只覆盖表达式，编译失败才退回
 * 「函数体」形式。不要在页面里用 `instanceof SyntaxError` 判断——跨 realm 时它不成立，
 * 旧实现因此把回退写成了死代码（实测 `const z = 5; z*2` 直接报 Unexpected token）。
 */

const code = args.code;
let runner = null;
try {
  runner = new Function('return (' + code + ')');
} catch {
  runner = null;
}
if (!runner) {
  try {
    runner = new Function(code);
  } catch (error) {
    return {
      ok: false,
      error: '代码既不是表达式也不是合法的函数体: ' + (error && error.message ? error.message : String(error)),
      url: window.location.href,
      title: document.title,
    };
  }
}

const value = await runner();
let json;
try {
  json = JSON.stringify(value);
} catch {
  json = JSON.stringify(String(value));
}
if (json === undefined) json = 'undefined';

// 16000 字符是给模型侧的显示上限，超出截断并打标记
const truncated = json.length > 16000;
return {
  ok: true,
  valueType: value === null ? 'null' : typeof value,
  json: truncated ? json.slice(0, 16000) + '...(truncated)' : json,
  truncated,
  url: window.location.href,
  title: document.title,
};
