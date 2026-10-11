const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createRenderer, shallowRef, nextTick } = require('vue');

function loadScroll() {
  const filename = path.resolve(__dirname, '../src/views/chat/useChatScroll.ts');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return module.exports.useChatScroll;
}

function createContainer() {
  return {
    scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    children: [{}], calls: [],
    scrollTo(options) {
      this.calls.push(options);
      this.scrollTop = Math.max(0, options.top - this.clientHeight);
    },
  };
}

function mountScroll(t) {
  const observers = [];
  const frames = new Map();
  let frameId = 0;
  const keys = ['window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  globalThis.window = { setTimeout: () => 1, clearTimeout() {} };
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  const container = createContainer();
  const host = shallowRef({ getContainer: () => container });
  let scroll;
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null,
    nextSibling: () => null, createElement: () => ({}), createText: () => ({}),
    setText() {}, setElementText() {}, patchProp() {},
  });
  const app = renderer.createApp({
    setup() { scroll = loadScroll()({ messagesContainerRef: host }); return () => null; },
  });
  app.mount({});
  t.after(() => {
    app.unmount();
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
      else delete globalThis[key];
    });
  });
  return {
    scroll, container, host, observers, app,
    resize(target = container.children[0]) {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback([]);
      }
    },
    async flush() {
      await nextTick();
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
    },
  };
}

test('下一帧之后底栏出现、过程收起和最终布局变化都继续吸底', async t => {
  const fixture = mountScroll(t);
  fixture.scroll.scrollToBottomIfAuto();
  await fixture.flush();
  for (const height of [1260, 1180, 1010, 900, 930]) {
    fixture.container.scrollHeight = height;
    fixture.resize();
    assert.equal(fixture.container.scrollTop, height - fixture.container.clientHeight);
    assert.equal(fixture.scroll.shouldAutoScroll.value, true);
  }
});

test('用户上滑后高度变化不抢位置，回到底部后恢复跟随', async t => {
  const fixture = mountScroll(t);
  fixture.scroll.handleMessagesWheel({ deltaY: -1 });
  fixture.container.scrollTop = 500;
  fixture.container.scrollHeight = 1400;
  fixture.resize();
  assert.equal(fixture.container.scrollTop, 500);
  assert.equal(fixture.scroll.isNearBottom.value, false);
  fixture.scroll.scrollToBottomForce();
  await fixture.flush();
  fixture.container.scrollHeight = 1500;
  fixture.resize();
  assert.equal(fixture.container.scrollTop, 1100);
});

test('触屏查看历史时折叠不抢位置', t => {
  const fixture = mountScroll(t);
  fixture.scroll.handleTouchStart({ touches: [{ clientY: 100 }] });
  fixture.scroll.handleTouchMove({ touches: [{ clientY: 140 }] });
  fixture.container.scrollTop = 300;
  fixture.container.scrollHeight = 1000;
  fixture.resize();
  assert.equal(fixture.container.scrollTop, 300);
});

test('尺寸通知不打断点击回到底部的平滑滚动', async t => {
  const fixture = mountScroll(t);
  fixture.scroll.handleScrollToBottomClick();
  await fixture.flush();
  const calls = fixture.container.calls.length;
  fixture.resize();
  assert.equal(fixture.container.calls.length, calls);
  assert.equal(fixture.container.calls.at(-1).behavior, 'smooth');
});

test('容器切换后解除旧观察，清理后停止跟随', async t => {
  const fixture = mountScroll(t);
  const replacement = createContainer();
  fixture.host.value = { getContainer: () => replacement };
  await nextTick();
  assert.equal(fixture.observers[0].targets.size, 0);
  replacement.scrollHeight = 1600;
  fixture.resize(replacement.children[0]);
  assert.equal(replacement.scrollTop, 1200);
  fixture.scroll.cleanupScroll();
  assert.equal(fixture.observers.at(-1).targets.size, 0);
  replacement.scrollHeight = 1700;
  fixture.resize(replacement.children[0]);
  assert.equal(replacement.scrollTop, 1200);
});
