import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const requireCjs = createRequire(import.meta.url);
const pressKey = requireCjs('../electron/mcp/tools/browser-press-key.cjs');
const clickTool = requireCjs('../electron/mcp/tools/browser-click.cjs');
const waitTool = requireCjs('../electron/mcp/tools/browser-wait.cjs');
const fillTool = requireCjs('../electron/mcp/tools/browser-fill.cjs');

type FakeTab = {id: string; url: string; title: string; loadState?: string};

function createHost(overrides: Record<string, unknown> = {}) {
  const tab: FakeTab = {id: 'tab-1', url: 'https://example.com/a', title: 'A', loadState: 'loaded'};
  const calls = {
    sendKey: [] as Array<{key: string; modifiers: string[]}>,
    scripts: [] as Array<{name: string; args: unknown}>,
    slept: [] as number[],
    navigationWatch: 0,
    hover: [] as Array<{x: number; y: number}>,
  };
  const host = {
    defaultClickSelector: 'a,button',
    acquireState: async () => ({activeTabId: tab.id, tabs: [tab]}),
    resolveTab: (_state: unknown, tabId: string) => (tabId && tabId !== tab.id ? {...tab, id: tabId} : tab),
    withAgentControl: async (_tab: FakeTab, fn: () => Promise<unknown>) => fn(),
    runScript: async (_tab: FakeTab, name: string, args: unknown) => {
      calls.scripts.push({name, args});
      if (name === 'wait-check') return {matched: false, url: tab.url, title: tab.title};
      if (name === 'focus') return {ok: true};
      if (name === 'press-key-fallback') return {ok: true, mode: 'script'};
      if (name === 'click') return {ok: true, currentUrl: tab.url, currentTitle: tab.title};
      if (name === 'fill-prepare') return {ok: true, mode: 'script', kind: 'input'};
      if (name === 'fill-type') return {ok: true, valueLength: 3};
      if (name === 'submit') return {ok: true, submitted: true};
      return {ok: true};
    },
    sleep: async (ms: number) => { calls.slept.push(ms); },
    beginNavigationWatch: () => {
      calls.navigationWatch += 1;
      return Promise.resolve({navigated: true, url: 'https://example.com/b', title: 'B', loadState: 'loaded'});
    },
    canSendInputEvent: () => true,
    focusContents: () => {},
    sendKey: (_tab: FakeTab, key: string, modifiers: string[]) => { calls.sendKey.push({key, modifiers}); },
    canCdpInsert: () => false,
    canInsertText: () => false,
    dispatchHover: async (_tab: FakeTab, x: number, y: number) => { calls.hover.push({x, y}); },
    ...overrides,
  };
  return {host, calls, tab};
}

test('browser_press_key：方向键翻成 Electron keyCode 再发事件，Enter 额外等导航', async () => {
  const {host, calls} = createHost();
  const arrow = await pressKey.run(host, {key: 'ArrowDown'});
  assert.deepEqual(calls.sendKey, [{key: 'Down', modifiers: []}]);
  assert.equal(arrow.inputKeyCode, 'Down');
  assert.equal(arrow.navigated, false);
  assert.equal(calls.navigationWatch, 0);

  const enter = await pressKey.run(host, {key: 'Enter'});
  assert.deepEqual(calls.sendKey.at(-1), {key: 'Return', modifiers: []});
  assert.equal(calls.navigationWatch, 1);
  assert.equal(enter.navigated, true);
  assert.equal(enter.url, 'https://example.com/b');

  // 非法键名在碰 host 之前就失败：不能发一个空键还报成功
  const before = calls.sendKey.length;
  await assert.rejects(() => pressKey.run(host, {key: 'ArrowSideways'}), /不支持的按键/);
  assert.equal(calls.sendKey.length, before);
});

test('browser_press_key：拿不到原生输入通道时退回页面脚本', async () => {
  const {host, calls} = createHost({canSendInputEvent: () => false});
  const result = await pressKey.run(host, {key: 'Escape'});
  assert.equal(calls.sendKey.length, 0);
  assert.deepEqual(calls.scripts.at(-1), {name: 'press-key-fallback', args: {key: 'Escape', modifiers: []}});
  assert.equal(result.ok, true);
});

test('browser_click：点击后等导航并用新 URL 回答，hover 只发原生移动', async () => {
  const {host, calls} = createHost();
  const clicked = await clickTool.run(host, {selector: '.submit-btn'});
  assert.equal(calls.navigationWatch, 1);
  assert.equal(clicked.url, 'https://example.com/b');
  assert.equal(clicked.title, 'B');
  assert.equal(clicked.navigated, true);
  assert.equal(clicked.loadState, 'loaded');

  const hovered = await clickTool.run(host, {selector: '.menu', hoverOnly: true});
  assert.equal(calls.navigationWatch, 1, 'hover 不该等导航');
  assert.equal(calls.hover.length, 1);
  assert.equal(hovered.navigated, false);

  await assert.rejects(() => clickTool.run(host, {}), /ref、selector 与 text 不能同时为空/);
});

test('browser_wait：超时上限按 schema 裁剪，超时抛 WAIT_TIMEOUT', async () => {
  const {host, calls} = createHost();
  await waitTool.run(host, {ms: 999999});
  assert.deepEqual(calls.slept, [15000]);

  await waitTool.run(host, {});
  assert.equal(calls.slept.at(-1), 1000);

  await assert.rejects(() => waitTool.run(host, {selector: '.never', timeoutMs: 1}), /等待超时/);
});

test('browser_fill：submit 只走一条页面脚本路径，不再分叉', async () => {
  const {host, calls} = createHost();
  const filled = await fillTool.run(host, {selector: '#name', value: 'abc', submit: true});
  const names = calls.scripts.map(item => item.name);
  assert.deepEqual(names, ['fill-prepare', 'fill-type', 'submit']);
  assert.equal(calls.navigationWatch, 1, 'submit 后要等导航');
  assert.equal(filled.navigated, true);
  assert.equal(filled.url, 'https://example.com/b');

  // 不提交时不碰 submit 脚本，也不等导航
  calls.scripts.length = 0;
  await fillTool.run(host, {selector: '#name', value: 'abc'});
  assert.deepEqual(calls.scripts.map(item => item.name), ['fill-prepare', 'fill-type']);

  await assert.rejects(() => fillTool.run(host, {value: 'x'}), /ref 与 selector 不能同时为空/);
});
