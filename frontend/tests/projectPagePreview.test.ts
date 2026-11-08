/**
 * 项目页面预览（阶段一）单元测试：地址校验 + 加载状态机 + generation 失效保护。
 *
 * <p>状态机是纯内存逻辑，不需要 DOM：composable 在没有 `window.electronAPI` 时静默跳过主进程订阅，
 * 因此这里直接以「主进程事件」喂给 {@code applyDiagnosticEvent}，验证状态归并口径。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  PROJECT_PAGE_LOAD_TIMEOUT_MS,
  useProjectPagePreview,
  validateProjectPageUrl,
} from '../src/composables/useProjectPagePreview';
import type {ProjectPagePreviewApi} from '../src/types/projectPagePreview';

const ADDRESS = 'http://localhost:5173/';
const OTHER_ADDRESS = 'http://127.0.0.1:5180/settings?tab=theme';
const {normalizeTargetOrigin} = createRequire(import.meta.url)('../electron/project-page-preview.cjs');

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

test('状态机：已确认失败后 iframe load 弱证据不得覆盖，且失败诊断带原因码提示', () => {
  const preview = createPreview();
  preview.openAddress(ADDRESS);
  preview.applyDiagnosticEvent({
    type: 'did-fail-load',
    generation: preview.generation.value,
    errorCode: -27,
    errorDescription: 'ERR_BLOCKED_BY_RESPONSE',
  });
  assert.equal(preview.loadState.value, 'failed');
  assert.match(preview.diagnoseText.value, /X-Frame-Options/);
  assert.match(preview.diagnoseText.value, /ERR_BLOCKED_BY_RESPONSE/);

  preview.handleFrameLoad();
  assert.equal(preview.loadState.value, 'failed', 'iframe 的 load 事件在失败后是弱证据，不能翻案');
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
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/', '超时不得销毁 iframe 地址');

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
  assert.equal(preview.committedUrl.value, 'http://localhost:5173/', '超时提示不得销毁 iframe 地址');

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
