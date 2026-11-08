/**
 * 项目页面预览（阶段一）单元测试：地址校验 + 加载状态机 + generation 失效保护。
 *
 * <p>状态机是纯内存逻辑，不需要 DOM：composable 在没有 `window.electronAPI` 时静默跳过主进程订阅，
 * 因此这里直接以「主进程事件」喂给 {@code applyDiagnosticEvent}，验证状态归并口径。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {
  PROJECT_PAGE_LOAD_TIMEOUT_MS,
  useProjectPagePreview,
  validateProjectPageUrl,
} from '../src/composables/useProjectPagePreview';
import type {ProjectPagePreviewApi} from '../src/types/projectPagePreview';

const ADDRESS = 'http://localhost:5173/';
const OTHER_ADDRESS = 'http://127.0.0.1:5180/settings?tab=theme';
const {normalizeTargetOrigin, normalizeTargetUrl, normalizeLayout, registerProjectPagePreview, CHANNELS} = createRequire(import.meta.url)('../electron/project-page-preview.cjs');

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 起一个已提交地址的预览状态机（不触发任何计时器等外部副作用时用小超时避免悬挂）。 */
function createPreview(timeoutMs = 60000): ProjectPagePreviewApi {
  return useProjectPagePreview({timeoutMs});
}

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

test('默认超时常量为 15 秒', () => {
  assert.equal(PROJECT_PAGE_LOAD_TIMEOUT_MS, 15000);
});

test('状态机：提交地址后进入载入，页面加载事件推进到已收到加载事件', () => {
  const preview = createPreview();
  assert.equal(preview.loadState.value, 'idle');
  assert.equal(preview.open.value, false);

  preview.openAddress(ADDRESS);
  assert.equal(preview.open.value, true);
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/');
  assert.equal(preview.committedOrigin.value, 'http://localhost:5173');
  assert.equal(preview.loadState.value, 'loading');
  assert.equal(preview.generation.value, 1);

  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: preview.generation.value, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');
  preview.close();
});

test('状态机：旧代（旧地址）的迟到结果不得覆盖新地址状态', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  const staleGeneration = preview.generation.value;

  preview.openAddress(OTHER_ADDRESS);
  const currentGeneration = preview.generation.value;
  assert.notEqual(currentGeneration, staleGeneration);
  assert.equal(preview.committedUrl.value, OTHER_ADDRESS);
  assert.equal(preview.loadState.value, 'loading');

  // 旧地址的迟到失败：必须被 generation 保护丢弃
  preview.applyDiagnosticEvent({
    type: 'did-fail-load',
    generation: staleGeneration,
    errorCode: -102,
    errorDescription: 'ERR_CONNECTION_REFUSED',
  });
  assert.equal(preview.loadState.value, 'loading', '旧代的失败结果不能改写新地址的状态');
  assert.equal(preview.diagnoseText.value, '', '旧代证据不能触发诊断提示');

  // 旧地址的迟到成功同样不能把新地址标成已加载
  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: staleGeneration, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loading');

  // 当前代的证据才生效
  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: currentGeneration, url: OTHER_ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');
  preview.close();
});

test('状态机：已确认失败后迟到完成事件不得覆盖，且失败诊断带原因码提示', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  preview.applyDiagnosticEvent({
    type: 'did-fail-load',
    generation: preview.generation.value,
    errorCode: -27,
    errorDescription: 'ERR_BLOCKED_BY_RESPONSE',
  });
  assert.equal(preview.loadState.value, 'failed');
  assert.match(preview.diagnoseText.value, /网站阻止/);
  assert.match(preview.diagnoseText.value, /ERR_BLOCKED_BY_RESPONSE/);

  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: preview.generation.value});
  assert.equal(preview.loadState.value, 'failed', '同一次导航的迟到完成事件不能覆盖已确认失败');
  preview.close();
});

test('状态机：连接被拒绝给出服务未启动的提示，而不是猜测被拒绝嵌入', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  preview.applyDiagnosticEvent({
    type: 'did-fail-load',
    generation: preview.generation.value,
    errorCode: -102,
    errorDescription: 'ERR_CONNECTION_REFUSED',
  });
  assert.equal(preview.loadState.value, 'failed');
  assert.doesNotMatch(preview.diagnoseText.value, /X-Frame-Options/);
  preview.close();
});

test('状态机：等待超时只改提示不销毁实例，迟到的成功仍可更新状态', async () => {
  const preview = useProjectPagePreview({timeoutMs: 20});
  preview.openAddress(ADDRESS);
  const attempt = preview.generation.value;
  await delay(60);
  assert.equal(preview.loadState.value, 'timeout');
  assert.match(preview.diagnoseText.value, /超时/);
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/', '超时不得销毁 网页地址');

  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: attempt, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded', '迟到成功的加载可以更新状态');
  assert.equal(preview.diagnoseText.value, '');
  preview.close();
});

test('状态机：loaded 后同代再次 did-start-loading 必须重开超时计时器（不能永久停在加载中）', async () => {
  const preview = useProjectPagePreview({timeoutMs: 30});
  preview.openAddress(ADDRESS);
  const attempt = preview.generation.value;

  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: attempt, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');

  // 页内二次加载：loaded 时计时器已 clearTimer，这里若不重开就再没有任何兜底
  preview.applyDiagnosticEvent({type: 'did-start-loading', generation: attempt, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loading', '又发起了一次加载，语义上确实回到等待');

  await delay(90);
  assert.equal(preview.loadState.value, 'timeout', '加载等待超过阈值后必须给出结论，而不是永久 loading');
  assert.match(preview.diagnoseText.value, /超时/);
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/', '超时提示不得销毁 网页地址');

  // 这次等待里迟到的成功仍可更新状态
  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: attempt, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');
  preview.close();
});

test('状态机：同代 did-start-loading 反复出现时，每次都会重置计时窗口', async () => {
  const preview = useProjectPagePreview({timeoutMs: 80});
  preview.openAddress(ADDRESS);
  const attempt = preview.generation.value;
  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: attempt, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');

  // 第一次 start → 计时窗口 80ms；50ms 后再来一次 start → 应重新起表，而不是沿用旧表
  preview.applyDiagnosticEvent({type: 'did-start-loading', generation: attempt, url: ADDRESS});
  await delay(50);
  preview.applyDiagnosticEvent({type: 'did-start-loading', generation: attempt, url: ADDRESS});
  await delay(50);
  assert.equal(preview.loadState.value, 'loading', '第二次 start 应重置计时窗口，此刻还没到点');
  await delay(80);
  assert.equal(preview.loadState.value, 'timeout');
  preview.close();
});

test('状态机：重新加载换代并回到载入态，地址不变', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  const first = preview.generation.value;
  preview.applyDiagnosticEvent({type: 'did-finish-load', generation: first, url: ADDRESS});
  assert.equal(preview.loadState.value, 'loaded');

  preview.reload();
  assert.equal(preview.generation.value, first + 1);
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/');
  assert.equal(preview.loadState.value, 'loading');
  preview.close();
});

test('状态机：非法地址给可见错误且不改动已提交地址', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  const generation = preview.generation.value;

  preview.openAddress('ftp://example.com/');
  assert.notEqual(preview.addressError.value, '');
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/');
  assert.equal(preview.generation.value, generation);

  preview.updateAddress('http://localhost:5173/x');
  assert.equal(preview.addressError.value, '', '编辑地址清掉上一次校验错误');
  preview.close();
});

test('状态机：关闭后销毁实例、忽略旧代事件、保留地址输入', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  const generation = preview.generation.value;
  preview.close();

  assert.equal(preview.open.value, false);
  assert.equal(preview.committedUrl.value, '');
  assert.equal(preview.loadState.value, 'idle');
  assert.notEqual(preview.generation.value, generation);

  preview.applyDiagnosticEvent({type: 'did-finish-load', generation, url: ADDRESS});
  assert.equal(preview.loadState.value, 'idle', '关闭后的旧代事件必须被丢弃');
});


test('状态机：跨站跳转更新真实地址，编辑中的输入与旧代事件不被覆盖', () => {
  const preview = createPreview();
  try {
    preview.openAddress(ADDRESS);
    const generation = preview.generation.value;
    const target = 'https://example.com/docs#intro';
    preview.applyDiagnosticEvent({type: 'did-navigate', generation, url: target});
    assert.equal(preview.committedUrl.value, target);
    assert.equal(preview.committedOrigin.value, 'https://example.com');
    assert.equal(preview.addressInput.value, target);
    preview.updateAddress('https://editing.example/');
    preview.applyDiagnosticEvent({type: 'did-navigate', generation, url: target + '-next'});
    assert.equal(preview.committedUrl.value, target + '-next');
    assert.equal(preview.addressInput.value, 'https://editing.example/');
    preview.applyDiagnosticEvent({type: 'did-navigate', generation: generation - 1, url: ADDRESS});
    assert.equal(preview.committedUrl.value, target + '-next');
    preview.reload();
    assert.equal(preview.committedUrl.value, target + '-next');
  } finally { preview.close(); }
});

test('状态机：失败后重新导航可以恢复加载与完成状态', () => {
  const preview = createPreview();
  try {
    preview.openAddress(ADDRESS);
    const generation = preview.generation.value;
    preview.applyDiagnosticEvent({type: 'did-fail-load', generation, errorCode: -102});
    preview.applyDiagnosticEvent({type: 'did-start-loading', generation, url: OTHER_ADDRESS});
    assert.equal(preview.loadState.value, 'loading');
    assert.equal(preview.failureDetail.value, '');
    preview.applyDiagnosticEvent({type: 'did-finish-load', generation, url: OTHER_ADDRESS});
    assert.equal(preview.loadState.value, 'loaded');
  } finally { preview.close(); }
});

test('主进程布局校验：拒绝非有限数、负尺寸和非法可见性', () => {
  const valid = {visible: true, bounds: {x: 10.4, y: 20.6, width: 400.2, height: 300.1}};
  assert.deepEqual(normalizeLayout(valid), {visible: true, bounds: {x: 10, y: 21, width: 400, height: 300}});
  for (const width of [NaN, Infinity, -1, 100001]) {
    assert.throws(() => normalizeLayout({...valid, bounds: {...valid.bounds, width}}));
  }
  assert.throws(() => normalizeLayout({...valid, visible: 'true'}));
  assert.equal(normalizeTargetUrl('https://example.com/a?q=1#b'), 'https://example.com/a?q=1#b');
});


test('原生视图 IPC：权限隔离、来源校验、缩放裁剪、保活与换代释放', t => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  const views: FakeView[] = [];
  class FakeContents extends EventEmitter {
    id = 1;
    mainFrame = {};
    destroyed = false;
    url = '';
    open: any;
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('destroyed'); }
    getURL() { return this.url; }
    getZoomFactor() { return 2; }
    loadURL(url: string) { this.url = url; return Promise.resolve(); }
    send(_channel: string, payload: unknown) { events.push(payload); }
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
    contentView: {addChildView: (view: FakeView) => children.push(view),
      removeChildView: (view: FakeView) => children.splice(children.indexOf(view), 1)}};
  const partition = new EventEmitter() as any;
  let requestPermission: any;
  let checkPermission: any;
  partition.setPermissionRequestHandler = (handler: any) => { requestPermission = handler; };
  partition.setPermissionCheckHandler = (handler: any) => { checkPermission = handler; };
  const registration = registerProjectPagePreview({
    ipcMain: {handle: (channel: string, callback: any) => handlers.set(channel, callback), removeHandler: (channel: string) => handlers.delete(channel)},
    getWindow: () => window, WebContentsView: FakeView,
    session: {fromPartition: (name: string) => { assert.equal(name, 'persist:lingxi-project-pages'); return partition; }},
  });
  t.after(() => registration.close());
  const sender = {sender: host, senderFrame: host.mainFrame};
  const invoke = (channel: string, request: unknown, event = sender) => handlers.get(channel)!(event, request);
  const request = {url: ADDRESS, generation: 1};
  assert.equal(invoke(CHANNELS.navigate, request, {...sender, senderFrame: {}}).ok, false);
  assert.equal(views.length, 0);
  assert.equal(invoke(CHANNELS.navigate, request).ok, true);
  const old = views[0]!;
  assert.equal(old.options.webPreferences.nodeIntegration, false);
  assert.equal(old.options.webPreferences.contextIsolation, true);
  assert.equal(old.options.webPreferences.sandbox, true);
  assert.equal(old.options.webPreferences.webSecurity, true);
  assert.equal(old.options.webPreferences.preload, undefined);
  assert.equal(checkPermission(), false);
  requestPermission(null, 'media', (allowed: boolean) => assert.equal(allowed, false));
  let blocked = false;
  partition.emit('will-download', {preventDefault: () => { blocked = true; }});
  assert.equal(blocked, true);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    blocked = false;
    old.webContents.emit(eventName, {preventDefault: () => { blocked = true; }}, 'file:///D:/secret.txt');
    assert.equal(blocked, true);
  }
  assert.deepEqual(old.webContents.open({url: 'https://other.example/page'}), {action: 'deny'});
  assert.equal(old.webContents.url, 'https://other.example/page');
  old.webContents.open({url: 'javascript:alert(1)'});
  assert.equal(old.webContents.url, 'https://other.example/page');
  const layout = {generation: 1, visible: true, bounds: {x: 400, y: 100, width: 200, height: 400}};
  invoke(CHANNELS.layout, layout);
  assert.deepEqual(old.bounds, {x: 800, y: 200, width: 200, height: 600});
  assert.equal(old.visible, true);
  invoke(CHANNELS.layout, {...layout, visible: false});
  assert.equal(old.visible, false);
  assert.equal(old.webContents.destroyed, false);
  invoke(CHANNELS.navigate, {url: OTHER_ADDRESS, generation: 2});
  const current = views[1]!;
  assert.equal(old.webContents.destroyed, true);
  assert.equal(children.length, 1);
  events.length = 0;
  old.webContents.emit('did-finish-load');
  assert.deepEqual(events, []);
  assert.equal(invoke(CHANNELS.layout, layout).data.applied, false);
  assert.equal(invoke(CHANNELS.close, {generation: 1}).data.released, false);
  assert.equal(current.webContents.destroyed, false);
  current.webContents.emit('did-navigate', {}, 'https://other.example/');
  assert.deepEqual(events.pop(), {type: 'did-navigate', generation: 2, url: 'https://other.example/'});
  invoke(CHANNELS.close, {generation: 3});
  assert.equal(current.webContents.destroyed, true);
  assert.equal(children.length, 0);
  assert.equal(invoke(CHANNELS.navigate, {url: ADDRESS, generation: 2}).ok, false);
  invoke(CHANNELS.navigate, {url: ADDRESS, generation: 4});
  host.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
  assert.equal(views[2]!.webContents.destroyed, true);
  invoke(CHANNELS.navigate, {url: ADDRESS, generation: 1});
  host.close();
  assert.equal(views[3]!.webContents.destroyed, true);
  assert.equal(children.length, 0);
});


test('桌面通道：加载拒绝要显示失败，旧请求回执不能覆盖新页面', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const layoutCalls: unknown[] = [];
  const closeCalls: number[] = [];
  let resolveFirst: (result: unknown) => void = () => {};
  let calls = 0;
  let subscribed = false;
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {electronAPI: {projectPage: {
    onEvent: () => { subscribed = true; return () => { subscribed = false; }; },
    navigate: () => {
      assert.equal(subscribed, true, '监听必须先于加载');
      if (++calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve({ok: true, data: {generation: 2}});
    },
    layout: (request: unknown) => { layoutCalls.push(request); return Promise.resolve({ok: true, data: {applied: true}}); },
    close: ({generation}: {generation: number}) => { closeCalls.push(generation); return Promise.resolve({ok: true, data: {released: true}}); },
  }}}});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const preview = createPreview();
  try {
    preview.openAddress(ADDRESS);
    preview.openAddress(OTHER_ADDRESS);
    resolveFirst({ok: false, error: '旧视图创建失败'});
    await delay(0);
    assert.equal(preview.loadState.value, 'loading');
    assert.equal(preview.failureDetail.value, '');
    assert.ok(layoutCalls.length > 0);
    assert.equal((layoutCalls.at(-1) as {generation: number}).generation, preview.generation.value);
    window.electronAPI!.projectPage!.navigate = async () => ({ok: false, error: '原生视图创建失败'});
    preview.reload();
    await delay(0);
    assert.equal(preview.loadState.value, 'failed');
    assert.match(preview.failureDetail.value, /原生视图创建失败/);
  } finally {
    preview.close();
    assert.equal(subscribed, false);
    assert.equal(closeCalls.at(-1), preview.generation.value);
  }
});
