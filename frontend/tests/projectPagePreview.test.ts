import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {useProjectPagePreview, validateProjectPageUrl} from '../src/composables/useProjectPagePreview';
import type {ProjectPageState, ProjectPageTab} from '../src/types/projectPagePreview';
const {normalizeTargetOrigin, normalizeTargetUrl, normalizeLayout, registerProjectPagePreview, CHANNELS, PROJECT_PAGE_LOAD_TIMEOUT_MS} = createRequire(import.meta.url)('../electron/project-page-preview.cjs');
const ADDRESS = 'http://localhost:5173/';
const OTHER_ADDRESS = 'https://example.com/other';
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('URL 校验：接受回环地址并保留 path / query / hash', () => {
  const withQuery = validateProjectPageUrl('http://localhost:5173/settings/profile?tab=theme#section');
  assert.equal(withQuery.ok, true);
  if (!withQuery.ok) return;
  assert.equal(withQuery.origin, 'http://localhost:5173');
  assert.match(withQuery.url, /\/settings\/profile\?tab=theme#section$/);

  for (const address of ['http://127.0.0.1:8080/', 'http://[::1]:5173/app', 'https://localhost:8443/']) {
    const result = validateProjectPageUrl(address);
    assert.equal(result.ok, true, `${address} 应被接受`);
  }
});

test('URL 校验：拒绝非 http/https 协议', () => {
  for (const address of ['ftp://localhost:21/', 'file:///D:/app/index.html', 'ws://localhost:5173/']) {
    const result = validateProjectPageUrl(address);
    assert.equal(result.ok, false, `${address} 应被拒绝`);
    if (result.ok) return;
    assert.equal(result.reason, 'protocol');
  }
  // 没有 scheme 的写法会被 URL 解析成 scheme 本身，同样必须落到 protocol 分支
  const bare = validateProjectPageUrl('localhost:5173');
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.equal(bare.reason, 'protocol');
});

test('URL 校验：接受远程域名、局域网及 IPv6 地址', () => {
  for (const address of ['https://example.com/docs?q=preview#intro', 'http://example.com:8080/', 'http://192.168.1.10:5173/', 'http://[::2]:5173/']) {
    const result = validateProjectPageUrl(address);
    assert.deepEqual(result, {ok: true, url: address, origin: new URL(address).origin});
    assert.equal(normalizeTargetOrigin(address), new URL(address).origin);
  }
});

test('URL 校验：接受默认端口和显式标准端口', () => {
  for (const address of ['http://localhost/', 'https://127.0.0.1/api', 'https://example.com:443/', 'http://example.com:80/']) {
    const result = validateProjectPageUrl(address);
    const parsed = new URL(address);
    assert.deepEqual(result, {ok: true, url: parsed.href, origin: parsed.origin});
    assert.equal(normalizeTargetOrigin(address), parsed.origin);
  }
});

test('主进程地址校验：远程地址仍拒绝非网页协议、内嵌凭据和畸形地址', () => {
  for (const address of ['file:///D:/app/index.html', 'javascript:alert(1)', 'https://user:secret@example.com/', 'http://', '']) {
    assert.equal(validateProjectPageUrl(address).ok, false);
    assert.throws(() => normalizeTargetOrigin(address));
  }
});

test('URL 校验：拒绝内嵌账号密码、空地址与畸形地址', () => {
  const credential = validateProjectPageUrl('http://user:secret@localhost:5173/');
  assert.equal(credential.ok, false);
  if (!credential.ok) assert.equal(credential.reason, 'credentials');

  const empty = validateProjectPageUrl('   ');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'empty');

  const malformed = validateProjectPageUrl('http://');
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.reason, 'malformed');
});

function createHarness(timeoutMs = 15000) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: ProjectPageState[] = [];
  const views: FakeView[] = [];
  const callbacks = new Set<(state: ProjectPageState) => void>();
  class FakeContents extends EventEmitter {
    id = 1;
    mainFrame = {};
    destroyed = false;
    url = '';
    options: any;
    open: any;
    loads = 0;
    reloads = 0;
    loading = false;
    history: string[] = [];
    index = -1;
    navigationHistory = {
      canGoBack: () => this.index > 0,
      canGoForward: () => this.index < this.history.length - 1,
      goBack: () => { this.index--; this.finish(this.history[this.index]!); },
      goForward: () => { this.index++; this.finish(this.history[this.index]!); },
    };
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('destroyed'); }
    getURL() { return this.url; }
    isLoadingMainFrame() { return this.loading; }
    getZoomFactor() { return 2; }
    finish(url: string) {
      this.url = url;
      this.loading = true;
      this.emit('did-start-navigation', {}, url, false, true);
      if (url.endsWith('/hang')) return;
      this.emit('did-navigate', {}, url);
      if (url.endsWith('/fail')) this.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true);
      this.loading = false;
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
    loadURL(url: string, options: unknown) {
      this.loads++; this.options = options;
      this.history.splice(this.index + 1); this.history.push(url); this.index++;
      this.finish(url); return Promise.resolve();
    }
    reload() { this.reloads++; this.finish(this.url); }
    stop() { this.loading = false; this.emit('did-stop-loading'); }
    send(_channel: string, state: ProjectPageState) { events.push(state); callbacks.forEach(callback => callback(state)); }
    setWindowOpenHandler(handler: any) { this.open = handler; }
  }
  class FakeView {
    webContents = new FakeContents();
    visible = true;
    bounds: any;
    constructor(readonly options: any) { views.push(this); }
    setVisible(value: boolean) { this.visible = value; }
    setBounds(value: unknown) { this.bounds = value; }
  }
  const host = new FakeContents();
  const children: FakeView[] = [];
  const window = {webContents: host, isDestroyed: () => false, getContentSize: () => [1000, 800],
    contentView: {addChildView: (view: FakeView) => children.push(view), removeChildView: (view: FakeView) => children.splice(children.indexOf(view), 1)}};
  const partition = new EventEmitter() as any;
  let requestPermission: any;
  let checkPermission: any;
  partition.setPermissionRequestHandler = (handler: any) => { requestPermission = handler; };
  partition.setPermissionCheckHandler = (handler: any) => { checkPermission = handler; };
  const registration = registerProjectPagePreview({
    ipcMain: {handle: (channel: string, callback: any) => handlers.set(channel, callback), removeHandler: (channel: string) => handlers.delete(channel)},
    getWindow: () => window, WebContentsView: FakeView, timeoutMs,
    session: {fromPartition: (name: string) => { assert.equal(name, 'persist:lingxi-project-pages'); return partition; }},
  });
  const sender = {sender: host, senderFrame: host.mainFrame};
  const invoke = (action: string, request: any = {}, event = sender) => handlers.get(CHANNELS.command)!(event, {generation: 1, ...request, action});
  const layout = (request: any) => handlers.get(CHANNELS.layout)!(sender, {generation: 1, ...request});
  const bridge = {command: async (request: any) => invoke(request.action, request), layout: async (request: any) => layout(request),
    onEvent: (callback: (state: ProjectPageState) => void) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; }};
  return {views, events, children, host, sender, invoke, layout, bridge, registration, partition,
    getState: () => events.at(-1)!, checkPermission: () => checkPermission(), requestPermission: (...args: any[]) => requestPermission(...args)};
}

test('主进程创建标签并隔离权限，校验来源和网址，元数据只进入所属标签', t => {
  const h = createHarness(); t.after(() => h.registration.close());
  assert.equal(h.invoke('sync', {}, {...h.sender, senderFrame: {}}).ok, false);
  assert.equal(h.views.length, 0);
  const first = h.invoke('sync').data.activeTabId;
  const second = h.invoke('create', {url: OTHER_ADDRESS}).data.activeTabId;
  assert.notEqual(first, second);
  assert.equal(h.views.length, 2);
  assert.equal(h.checkPermission(), false);
  h.requestPermission(null, 'media', (allowed: boolean) => assert.equal(allowed, false));
  let blocked = false;
  h.partition.emit('will-download', {preventDefault: () => { blocked = true; }});
  assert.equal(blocked, true);
  const preferences = h.views[0]!.options.webPreferences;
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.preload, undefined);
  assert.equal(h.views[1]!.options.webPreferences.session, preferences.session);
  assert.equal(h.invoke('navigate', {tabId: first, url: 'file:///D:/secret'}).ok, false);
  assert.equal(h.invoke('create', {url: 'https://user:secret@example.com/'}).ok, false);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    blocked = false;
    h.views[0]!.webContents.emit(eventName, {preventDefault: () => { blocked = true; }}, 'file:///D:/secret');
    assert.equal(blocked, true);
  }
  h.views[0]!.webContents.emit('page-title-updated', {}, '后台标签');
  h.views[0]!.webContents.emit('page-favicon-updated', {}, ['file:///secret.png', 'https://example.com/icon.png']);
  assert.equal(h.getState().activeTabId, second);
  assert.equal(h.getState().tabs[0]!.title, '后台标签');
  assert.equal(h.getState().tabs[0]!.favicon, 'https://example.com/icon.png');
  assert.equal(h.getState().tabs[1]!.title, '');
});

test('标签切换保留实例，导航与刷新复用历史，关闭仅释放目标标签', t => {
  const h = createHarness(); t.after(() => h.registration.close());
  const first = h.invoke('create', {url: ADDRESS}).data.activeTabId;
  const firstView = h.views[0]!;
  h.invoke('navigate', {tabId: first, url: OTHER_ADDRESS});
  assert.equal(h.views.length, 1);
  assert.equal(h.getState().tabs[0]!.canGoBack, true);
  h.invoke('back', {tabId: first});
  assert.equal(h.getState().tabs[0]!.url, ADDRESS);
  assert.equal(h.getState().tabs[0]!.canGoForward, true);
  h.invoke('forward', {tabId: first});
  h.invoke('reload', {tabId: first});
  assert.equal(firstView.webContents.reloads, 1);
  assert.equal(firstView.webContents.loads, 2);
  assert.equal(firstView.webContents.history.length, 2);
  assert.equal(firstView.webContents.destroyed, false);
  const second = h.invoke('create', {url: ADDRESS}).data.activeTabId;
  h.layout({visible: true, bounds: {x: 400, y: 100, width: 200, height: 400}});
  assert.equal(firstView.visible, false);
  assert.equal(h.views[1]!.visible, true);
  assert.deepEqual(h.views[1]!.bounds, {x: 800, y: 200, width: 200, height: 600});
  h.invoke('activate', {tabId: first});
  assert.equal(firstView.visible, true);
  assert.equal(h.views[1]!.visible, false);
  h.layout({visible: false, bounds: {x: 0, y: 0, width: 200, height: 300}});
  assert.equal(h.views.every(view => !view.visible), true);
  h.invoke('close-tab', {tabId: second});
  assert.equal(h.views[1]!.webContents.destroyed, true);
  assert.equal(firstView.webContents.destroyed, false);
  const count = h.events.length;
  h.views[1]!.webContents.emit('page-title-updated', {}, '迟到事件');
  assert.equal(h.events.length, count);
  assert.equal(h.invoke('navigate', {tabId: second, url: ADDRESS}).ok, false);
  h.invoke('close-tab', {tabId: first});
  assert.equal(firstView.webContents.destroyed, true);
  assert.equal(h.getState().tabs.length, 1);
  assert.notEqual(h.getState().activeTabId, first);
  assert.equal(h.getState().tabs[0]!.url, '');
});

test('新窗口链接创建前台或后台标签，保留来源、表单数据与原标签', t => {
  const h = createHarness(); t.after(() => h.registration.close());
  const first = h.invoke('create', {url: ADDRESS}).data.activeTabId;
  const contents = h.views[0]!.webContents;
  assert.deepEqual(contents.open({url: OTHER_ADDRESS, disposition: 'foreground-tab'}), {action: 'deny'});
  const second = h.getState().activeTabId;
  assert.notEqual(second, first);
  assert.equal(contents.url, ADDRESS);
  const postBody = {contentType: 'application/x-www-form-urlencoded', data: [{type: 'rawData', bytes: Buffer.from('name=test')}]};
  contents.open({url: 'https://example.com/form', disposition: 'background-tab', postBody, referrer: {url: ADDRESS}});
  assert.equal(h.getState().activeTabId, second);
  assert.equal(h.views.length, 3);
  assert.deepEqual(h.views[2]!.webContents.options.postData, postBody.data);
  assert.match(h.views[2]!.webContents.options.extraHeaders, /application\/x-www-form-urlencoded/);
  contents.open({url: 'javascript:alert(1)'});
  assert.equal(h.views.length, 3);
});

test('超时与失败按标签隔离，停止加载与迟到成功均可结束等待', async t => {
  assert.equal(PROJECT_PAGE_LOAD_TIMEOUT_MS, 15000);
  const h = createHarness(15); t.after(() => h.registration.close());
  const slow = h.invoke('create', {url: 'https://example.com/hang'}).data.activeTabId;
  const other = h.invoke('create', {url: 'https://example.com/fail'}).data.activeTabId;
  await delay(35);
  assert.equal(h.getState().tabs.find(tab => tab.id === slow)!.loadState, 'timeout');
  assert.equal(h.getState().tabs.find(tab => tab.id === other)!.loadState, 'failed');
  h.views[0]!.webContents.emit('did-navigate', {}, 'https://example.com/hang');
  h.views[0]!.webContents.emit('did-finish-load');
  assert.equal(h.getState().tabs[0]!.loadState, 'loaded');
  h.invoke('navigate', {tabId: slow, url: 'https://example.com/hang'});
  h.invoke('stop', {tabId: slow});
  assert.equal(h.getState().tabs[0]!.loadState, 'stopped');
  assert.equal(h.getState().tabs[0]!.isLoading, false);
  h.invoke('navigate', {tabId: other, url: OTHER_ADDRESS});
  assert.equal(h.getState().tabs[1]!.loadState, 'loaded');
});

test('旧错误页的完成与停止事件不能结束尚未提交的新导航', async t => {
  const h = createHarness(15); t.after(() => h.registration.close());
  const id = h.invoke('create', {url: 'https://example.com/fail'}).data.activeTabId;
  h.invoke('navigate', {tabId: id, url: 'https://example.com/hang'});
  const contents = h.views[0]!.webContents;
  contents.emit('did-finish-load');
  contents.emit('did-stop-loading');
  assert.equal(h.getState().tabs[0]!.loadState, 'loading');
  assert.equal(h.getState().tabs[0]!.isLoading, true);
  await delay(35);
  assert.equal(h.getState().tabs[0]!.loadState, 'timeout');
  contents.emit('did-navigate', {}, 'https://example.com/hang');
  contents.loading = false;
  contents.emit('did-finish-load');
  assert.equal(h.getState().tabs[0]!.loadState, 'loaded');
});

test('会话关闭屏蔽旧请求，重新打开及主页面刷新都释放旧实例', t => {
  const h = createHarness(); t.after(() => h.registration.close());
  h.invoke('create', {url: ADDRESS}); h.invoke('create', {url: OTHER_ADDRESS});
  h.invoke('close', {generation: 2});
  assert.equal(h.children.length, 0);
  assert.equal(h.views.every(view => view.webContents.destroyed), true);
  assert.equal(h.invoke('sync', {generation: 1}).ok, false);
  assert.equal(h.invoke('sync', {generation: 2}).ok, false);
  h.invoke('sync', {generation: 3});
  assert.equal(h.invoke('close', {generation: 2}).ok, false);
  assert.equal(h.views[2]!.webContents.destroyed, false);
  h.host.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
  assert.equal(h.views[2]!.webContents.destroyed, true);
  h.invoke('sync'); h.host.close();
  assert.equal(h.views[3]!.webContents.destroyed, true);
});

test('布局校验拒绝非有限数、负尺寸与非法可见性', () => {
  const valid = {visible: true, bounds: {x: 10.4, y: 20.6, width: 400.2, height: 300.1}};
  assert.deepEqual(normalizeLayout(valid).bounds, {x: 10, y: 21, width: 400, height: 300});
  for (const width of [NaN, Infinity, -1, 100001]) assert.throws(() => normalizeLayout({...valid, bounds: {...valid.bounds, width}}));
  assert.throws(() => normalizeLayout({...valid, visible: 'true'}));
  assert.equal(normalizeTargetUrl('https://example.com/a?q=1#b'), 'https://example.com/a?q=1#b');
});

function installBridge(t: any, bridge: any) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {electronAPI: {projectPage: bridge}}});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
}

test('前端按权威快照渲染标签，草稿独立，旧版本和旧会话回执失效', async t => {
  const h = createHarness(); t.after(() => h.registration.close()); installBridge(t, h.bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress(ADDRESS);
  await delay(0);
  const first = preview.activeTabId.value;
  assert.equal(first, h.getState().activeTabId);
  assert.equal(preview.committedUrl.value, ADDRESS);
  preview.updateAddress('https://editing.example/');
  preview.createTab(); await delay(0);
  const second = preview.activeTabId.value;
  preview.openAddress(OTHER_ADDRESS); await delay(0);
  assert.equal(preview.tabs.value.length, 2);
  preview.activateTab(first); await delay(0);
  assert.equal(preview.addressInput.value, 'https://editing.example/');
  const stale = {...h.getState(), revision: h.getState().revision - 1, activeTabId: second};
  preview.applyState(stale);
  assert.equal(preview.activeTabId.value, first);
  const closedState = h.getState();
  preview.close(); preview.openAddress(); await delay(0);
  preview.applyState(closedState);
  assert.equal(preview.tabs.value.length, 1);
  assert.notEqual(preview.activeTabId.value, first);
});

test('收起面板保留主进程会话：不换代、不销毁标签，重开原样恢复', async t => {
  const h = createHarness(); t.after(() => h.registration.close()); installBridge(t, h.bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress(ADDRESS); await delay(0);
  const generation = preview.generation.value;
  const first = preview.activeTabId.value;
  preview.createTab(); await delay(0);
  preview.openAddress(OTHER_ADDRESS); await delay(0);
  assert.equal(preview.tabs.value.length, 2);
  preview.hide();
  // 收起只影响可见性：前端快照与主进程实例都必须活着。
  assert.equal(preview.open.value, false);
  assert.equal(preview.tabs.value.length, 2);
  assert.equal(preview.activeTabId.value, h.getState().activeTabId);
  assert.equal(h.views.filter(view => view.webContents.destroyed).length, 0);
  preview.openAddress(); await delay(0);
  assert.equal(preview.generation.value, generation);
  assert.equal(preview.tabs.value.length, 2);
  assert.equal(preview.tabs.value.some(tab => tab.id === first), true);
  assert.equal(h.views.filter(view => view.webContents.destroyed).length, 0);
});

test('close 销毁会话后重开换代并重建标签，旧实例不再复用', async t => {
  const h = createHarness(); t.after(() => h.registration.close()); installBridge(t, h.bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress(ADDRESS); await delay(0);
  const generation = preview.generation.value;
  const first = preview.activeTabId.value;
  preview.close();
  assert.deepEqual(preview.tabs.value, []);
  assert.equal(h.views[0]!.webContents.destroyed, true);
  preview.openAddress(); await delay(0);
  assert.ok(preview.generation.value > generation);
  assert.equal(preview.tabs.value.length, 1);
  assert.notEqual(preview.activeTabId.value, first);
  assert.equal(preview.tabs.value[0]!.url, '');
});

test('隐藏通知不覆盖最后一次真实位置，重开按原位恢复', async t => {
  const calls: any[] = [];
  const bridge = {onEvent: () => () => {},
    command: async () => ({ok: true, data: {generation: 1, revision: 1, activeTabId: '', tabs: []}}),
    layout: async (request: any) => { calls.push(request); return {ok: true, data: {applied: true}}; }};
  installBridge(t, bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress(); await delay(0);
  const bounds = {x: 700, y: 170, width: 500, height: 560};
  preview.updateLayout({visible: true, bounds}); await delay(0);
  // 卸载 / 收起常带全 0 尺寸，不能让它把最后位置抹掉（否则重开只能靠下一帧重新量尺寸）。
  preview.updateLayout({visible: false, bounds: {x: 0, y: 0, width: 0, height: 0}}); await delay(0);
  preview.hide(); await delay(0);
  calls.length = 0;
  preview.openAddress(); await delay(0);
  assert.deepEqual(calls.find(call => call.visible)?.bounds, bounds);
});

test('收起后隐藏布局仍透传，可见布局只在打开时透传', async t => {
  const calls: any[] = [];
  const bridge = {onEvent: () => () => {},
    command: async () => ({ok: true, data: {generation: 1, revision: 1, activeTabId: '', tabs: []}}),
    layout: async (request: any) => { calls.push(request); return {ok: true, data: {applied: true}}; }};
  installBridge(t, bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress(); await delay(0);
  calls.length = 0;
  preview.updateLayout({visible: true, bounds: {x: 1, y: 2, width: 3, height: 4}}); await delay(0);
  assert.equal(calls.length, 1);
  preview.hide(); await delay(0);
  assert.equal(calls.at(-1).visible, false);
  calls.length = 0;
  preview.updateLayout({visible: false, bounds: {x: 1, y: 2, width: 3, height: 4}}); await delay(0);
  assert.deepEqual(calls.map(call => call.visible), [false]);
  preview.updateLayout({visible: true, bounds: {x: 1, y: 2, width: 3, height: 4}}); await delay(0);
  assert.deepEqual(calls.map(call => call.visible), [false]);
});

test('前端不构造临时标签，通道失败可见，后台导航不覆盖编辑内容', async t => {
  let listener: (state: ProjectPageState) => void = () => {};
  let resolveRequest: (result: unknown) => void = () => {};
  const calls: any[] = [];
  const bridge = {onEvent: (callback: any) => { listener = callback; return () => {}; },
    command: (request: any) => { calls.push(request); return new Promise(resolve => { resolveRequest = resolve; }); },
    layout: async () => ({ok: true, data: {applied: true}})};
  installBridge(t, bridge);
  const preview = useProjectPagePreview(); t.after(() => preview.close());
  preview.openAddress();
  assert.deepEqual(preview.tabs.value, []);
  assert.equal(preview.activeTabId.value, '');
  assert.equal(calls[0].action, 'sync');
  preview.updateAddress('https://pending.example/');
  resolveRequest({ok: false, error: '网页标签创建失败'}); await delay(0);
  assert.match(preview.addressError.value, /创建失败/);
  const tab: ProjectPageTab = {id: 'native-tab', url: '', title: '', favicon: '', loadState: 'idle', isLoading: false,
    errorCode: 0, errorDescription: '', canGoBack: false, canGoForward: false};
  listener({generation: preview.generation.value, revision: 1, activeTabId: tab.id, tabs: [tab]});
  assert.equal(preview.addressInput.value, 'https://pending.example/');
  preview.updateAddress('https://draft.example/');
  listener({generation: preview.generation.value, revision: 2, activeTabId: tab.id, tabs: [{...tab, url: OTHER_ADDRESS}]});
  assert.equal(preview.committedUrl.value, OTHER_ADDRESS);
  assert.equal(preview.addressInput.value, 'https://draft.example/');
});
