/**
 * 发送消息后必须贴底的守护用例。
 *
 * <p>缺陷复盘：乐观提问是 messages.push（原地追加，数组引用不变），
 * useChatView 里 watch(displayedMessages) 因此一次都不触发；随后 RUNNING 骨架走的是
 * 「条件吸底」，而用户上翻历史已把 shouldAutoScroll 关掉 —— 表现为「消息发了，视图还在看历史」。
 *
 * <p>所以本用例钉两件事：① 发送链路上唯一被允许的滚动是强制贴底（行为层真跑一遍容器）；
 * ② 源码里发送链路不得再接条件吸底（回退即红）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createRenderer, shallowRef, nextTick } = require('vue');

const SRC = path.resolve(__dirname, '../src');

function readSource(relative) {
  return fs.readFileSync(path.resolve(SRC, relative), 'utf8');
}

function loadScroll() {
  const filename = path.resolve(SRC, 'views/chat/useChatScroll.ts');
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
    scroll, container,
    async flush() {
      await nextTick();
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback());
    },
  };
}

test('上翻历史后发送：只有强制贴底能把视图拉回底部', async t => {
  const { scroll, container, flush } = mountScroll(t);

  // 用户上翻查看历史：跟随模式关闭。
  scroll.handleMessagesWheel({ deltaY: -1 });
  container.scrollTop = 300;
  assert.equal(scroll.shouldAutoScroll.value, false);

  // 对照：条件吸底在跟随关闭时不抢位置 —— 这正是「发送后停在原处」的成因。
  scroll.scrollToBottomIfAuto();
  await flush();
  assert.equal(container.scrollTop, 300, '条件吸底不该在用户上翻后拽动视图');

  // 发送链路调的就是这个动作：必须回到最底部，并重新打开跟随。
  scroll.scrollToBottomForce();
  await flush();
  assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
  assert.equal(scroll.shouldAutoScroll.value, true);
  assert.equal(scroll.isNearBottom.value, true);

  // 跟随恢复后，本轮后续内容继续长高仍贴底（发送后不能只贴一次）。
  container.scrollHeight = 1500;
  scroll.scrollToBottomIfAuto();
  await flush();
  assert.equal(container.scrollTop, 1500 - container.clientHeight);
});

test('发送链路不得接条件吸底：只在乐观气泡插入处强制贴底', () => {
  const source = readSource('views/chat/useChatView.ts');

  const pushIndex = source.indexOf('streamRouter.pushUserMessage(');
  assert.ok(pushIndex >= 0, '发送链路必须仍在 push 乐观气泡');
  // 只认「紧随乐观气泡插入」的那一次调用：文件后面还有别处会调 scrollToBottomForce，
  // 用全文 indexOf 会让「删掉发送处那行」的变异存活（实测过一次，已改窗口口径）。
  assert.match(
    source.slice(pushIndex, pushIndex + 600),
    /scrollToBottomForce\(\);/,
    '乐观气泡插入后必须显式 scrollToBottomForce()',
  );

  const sendingIndex = source.indexOf('useChatSending({');
  assert.ok(sendingIndex >= 0, '发送链路必须仍通过 useChatSending 提交');
  const sendingBlock = source.slice(sendingIndex, source.indexOf('\n  });', sendingIndex));
  assert.match(sendingBlock, /\n\s+scrollToBottomForce,/, 'useChatSending 必须接强制贴底');
  assert.doesNotMatch(sendingBlock, /\n\s+scrollToBottom[,:]/, '不许把条件吸底接进发送链路');
});

test('useChatSending 的回执贴底选项钉成 force 语义', () => {
  const source = readSource('views/chat/useChatSending.ts');
  assert.match(source, /scrollToBottomForce: \(\) => void;/, '选项必须是强制贴底');
  assert.doesNotMatch(source, /scrollToBottom: \(\) => void;/, '旧的条件吸底选项名不得回退');
  const calls = source.match(/scrollToBottomForce\(\);/g) ?? [];
  assert.equal(calls.length, 2, '受理回执与补偿取消两条路径都要强制贴底');
});

test('useChatScroll 不再导出「force 参数默认条件吸底」的混血别名', () => {
  const source = readSource('views/chat/useChatScroll.ts');
  // 别名形如 `const scrollToBottom = (force = false) => ...` + return 里再列一次。
  // 用词边界锚定，避免误伤 scrollToBottomIfAuto / scrollToBottomForce / scrollToBottomClick。
  assert.doesNotMatch(source, /\bconst scrollToBottom\s*=/, '条件吸底别名 scrollToBottom 不得再被定义');
  assert.doesNotMatch(source, /\n\s+scrollToBottom,\n/, '条件吸底别名不得再出现在导出列表');
});
