import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const requireCjs = createRequire(import.meta.url);
const {KEY_ALIASES, toInputKeyCode, normalizeModifiers} = requireCjs('../electron/mcp/keymap.cjs');
const {normalizeInt, normalizeText, normalizeBoolean, normalizeEnum} = requireCjs('../electron/mcp/args.cjs');
const {TOOL_ERROR} = requireCjs('../electron/mcp/errors.cjs');
const {
  normalizeConsoleLevel,
  appendRingBuffer,
  normalizeHeaders,
  resolveContentType,
  formatNetworkEntrySummary,
} = requireCjs('../electron/mcp/logs.cjs');
const {BROWSER_TOOLS, DESIGN_TOOLS, listTools, findTool} = requireCjs('../electron/mcp/registry.cjs');
const {buildPageScript} = requireCjs('../electron/mcp/page-scripts.cjs');

function codeOf(thunk: () => unknown) {
  try {
    thunk();
  } catch (error) {
    return (error as {code?: string}).code;
  }
  return '';
}

test('MCP 按键词表：方向键必须翻译成 Electron keyCode，非法键名报错', () => {
  // sendInputEvent 只认 Electron accelerator 词表，ArrowDown 原样传下去会派发空键并静默失效
  assert.equal(toInputKeyCode('ArrowUp'), 'Up');
  assert.equal(toInputKeyCode('ArrowDown'), 'Down');
  assert.equal(toInputKeyCode('ArrowLeft'), 'Left');
  assert.equal(toInputKeyCode('ArrowRight'), 'Right');
  assert.equal(KEY_ALIASES.ArrowDown, 'Down');

  // 旧行为不能回退：Enter 一直是 Return
  assert.equal(toInputKeyCode('Enter'), 'Return');
  assert.equal(toInputKeyCode('enter'), 'Return');
  assert.equal(toInputKeyCode('Escape'), 'Escape');
  assert.equal(toInputKeyCode('esc'), 'Escape');
  assert.equal(toInputKeyCode('a'), 'a');
  assert.equal(toInputKeyCode('Tab'), 'Tab');
  assert.equal(toInputKeyCode('f5'), 'F5');

  assert.equal(codeOf(() => toInputKeyCode('')), TOOL_ERROR.INVALID_ARGUMENT);
  assert.equal(codeOf(() => toInputKeyCode('ArrowSideways')), TOOL_ERROR.UNSUPPORTED_KEY);

  assert.deepEqual(normalizeModifiers(['ctrl', 'Shift', 'cmd', 'ctrl']), ['control', 'shift', 'meta']);
  assert.deepEqual(normalizeModifiers(undefined), []);
  assert.equal(codeOf(() => normalizeModifiers(['hyper'])), TOOL_ERROR.UNSUPPORTED_KEY);
});

test('MCP 参数归一：上下限与 fallback 语义一致', () => {
  assert.equal(normalizeInt(1000, {fallback: 100, min: 1, max: 500}), 500);
  assert.equal(normalizeInt(undefined, {fallback: 100, min: 1, max: 500}), 100);
  assert.equal(normalizeInt(0, {fallback: 40, min: 1, max: 100}), 40);
  // min 为 0 的字段要保留 0，不能被当成「没给」
  assert.equal(normalizeInt(0, {fallback: 800, min: 0, max: 4000}), 0);
  assert.equal(normalizeInt(2.6, {fallback: 1, min: 0, max: 10}), 3);
  assert.equal(normalizeInt(Number.NaN, {fallback: 7, min: 0, max: 10}), 7);

  assert.equal(normalizeText('  hello  '), 'hello');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeBoolean('true', false), true);
  assert.equal(normalizeBoolean('false', true), false);
  assert.equal(normalizeBoolean(undefined, true), true);
  assert.equal(normalizeEnum('DOWN', ['down', 'up'], 'down'), 'down');
  assert.equal(normalizeEnum('sideways', ['down', 'up'], 'up'), 'up');
});

test('MCP 日志加工：bodyCaptured 必须区分「空响应体」与「没抓到」', () => {
  assert.equal(normalizeConsoleLevel('warn'), 'warning');
  assert.equal(normalizeConsoleLevel(0), 'verbose');
  assert.equal(normalizeConsoleLevel(3), 'error');
  assert.equal(normalizeConsoleLevel('noise'), 'info');

  const buffer: number[] = [];
  for (let index = 0; index < 5; index += 1) appendRingBuffer(buffer, index, 3);
  assert.deepEqual(buffer, [2, 3, 4]);

  assert.deepEqual(
    normalizeHeaders({'Content-Type': 'application/json', 'x-arr': ['a', 'b'], 'x-empty': null}),
    {'content-type': 'application/json', 'x-arr': 'a, b'},
  );
  assert.equal(resolveContentType({'content-type': 'text/html'}, 'application/json'), 'text/html');
  assert.equal(resolveContentType({}, 'application/json'), 'application/json');

  const captured = formatNetworkEntrySummary({
    id: 'r1',
    method: 'GET',
    url: 'https://example.com/api',
    statusCode: 200,
    ok: true,
    bodyCaptured: true,
    bodyLength: 40,
    responseBody: 'x'.repeat(40),
  }, {bodyPreviewLength: 10});
  assert.equal(captured.bodyCaptured, true);
  assert.equal(captured.bodyPreview, 'xxxxxxxxxx');
  assert.equal(captured.bodyTruncated, true);
  assert.equal(captured.bodyUnavailableReason, undefined);

  const missing = formatNetworkEntrySummary({
    id: 'r2',
    method: 'GET',
    url: 'https://example.com/api',
    statusCode: 200,
    ok: true,
    bodyCaptured: false,
    bodyUnavailableReason: '响应体尚未抓取完成',
  });
  assert.equal(missing.bodyCaptured, false);
  assert.equal(missing.bodyUnavailableReason, '响应体尚未抓取完成');
  assert.equal(missing.bodyPreview, undefined);

  const binary = formatNetworkEntrySummary({
    id: 'r3',
    method: 'GET',
    url: 'https://example.com/logo.png',
    statusCode: 200,
    ok: true,
    bodyCaptured: true,
    base64Encoded: true,
    bodyLength: 1024,
  });
  assert.equal(binary.bodyPreview, '[binary base64, 1024 chars]');

  const noHeaders = formatNetworkEntrySummary({id: 'r4', bodyCaptured: false}, {includeHeaders: false});
  assert.equal(noHeaders.requestHeaders, undefined);
  assert.equal(noHeaders.responseHeaders, undefined);
});

test('MCP 工具注册表：13 个 browser + 3 个 design，名称唯一且 schema 自洽', () => {
  assert.equal(listTools(false).length, 13);
  assert.equal(listTools(true).length, 16);
  assert.deepEqual(
    listTools(false).map((tool: {name: string}) => tool.name),
    [
      'browser_navigate', 'browser_click', 'browser_fill', 'browser_query', 'browser_screenshot',
      'browser_tabs', 'browser_wait', 'browser_scroll', 'browser_console', 'browser_network',
      'browser_network_detail', 'browser_evaluate', 'browser_press_key',
    ],
  );
  assert.deepEqual(
    DESIGN_TOOLS.map((tool: {name: string}) => tool.name),
    ['design_get_state', 'design_capture', 'design_resolve_comment'],
  );

  const names = listTools(true).map((tool: {name: string}) => tool.name);
  assert.equal(new Set(names).size, names.length);

  for (const tool of [...BROWSER_TOOLS, ...DESIGN_TOOLS]) {
    assert.equal(typeof tool.run, 'function', `${tool.name} 缺少 run`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 0, `${tool.name} 缺少 description`);
  }
  for (const tool of BROWSER_TOOLS) {
    // browser_tabs 是唯一的多动作工具，由服务端的 TAB_ACTIONS 映射到 listTabs/activateTab/closeTab
    if (tool.name === 'browser_tabs') continue;
    assert.equal(typeof tool.method, 'string', `${tool.name} 缺少 automation method`);
  }

  // 上下限与裁剪必须同源：schema 里的 maximum 就是执行时的 max
  const wait = findTool('browser_wait');
  assert.equal(wait.inputSchema.properties.timeoutMs.maximum, 15000);
  assert.equal(wait.inputSchema.properties.ms.maximum, 15000);
});

test('MCP 页面脚本：每个脚本体注入后语法合法', () => {
  const scripts = [
    'query', 'click', 'fill-prepare', 'fill-read', 'fill-type', 'submit',
    'focus', 'wait-check', 'scroll', 'evaluate', 'press-key-fallback', 'raf-wait',
  ];
  for (const name of scripts) {
    const script = buildPageScript(name, {probe: 1});
    // 必须是 async IIFE：evaluate 要 await 页面里的 Promise
    assert.match(script, /^\(async function \(args\)/);
    assert.doesNotThrow(() => new Function(`return ${script}`), `${name} 注入后语法不合法`);
  }

  // 行分隔符必须显式转义，否则整段注入脚本会被截断
  const escaped = buildPageScript('query', {text: 'a\u2028b'});
  assert.equal(escaped.includes('\u2028'), false);
  assert.match(escaped, /\\u2028/);
});
