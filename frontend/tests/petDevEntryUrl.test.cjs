/**
 * 开发态入口 URL 规整单测（node:test，不启动 Electron）。
 *
 * <p><b>守的是什么：</b>`ELECTRON_URL` 由批处理脚本设置，历史上出现过
 * `set VAR=url &amp;&amp; cmd` 把尾随空格一起设进去的坑，导致 `new URL('pet.html', url)`
 * 抛 `Invalid URL`、主进程弹「A JavaScript error occurred in the main process」。
 * 入口地址是可降级配置，脏值必须退化成默认端口而不是阻断启动。</p>
 *
 * <p>运行：`npm run test:pet`（node 直接跑，不需要 tsx / Electron）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveDevEntryUrl, DEV_ENTRY_FALLBACK } = require(path.join(__dirname, '..', 'electron', 'pet-window.cjs'));
const petWindow = require(path.join(__dirname, '..', 'electron', 'pet-window.cjs'));

// 端口一律从单一真源取（electron/pet-dev-endpoint.cjs），测试里不再写端口字面量：
// 曾经兜底地址写死主应用的 5174，导致窗口加载成主应用界面。
const { DEV_ENDPOINT } = require(path.join(__dirname, '..', 'electron', 'pet-dev-endpoint.cjs'));

/** 桌宠 dev server 端口。 */
const PORT = DEV_ENDPOINT.port;
/** 桌宠 dev server 来源地址（无结尾斜杠）。 */
const ORIGIN = `http://127.0.0.1:${PORT}`;

test('入口页（K4）：dev 与 dist 两条分支都只用真源里的入口页名', () => {
  const entryPage = DEV_ENDPOINT.entryPage;

  const dev = petWindow.resolveEntrySpec({ isDev: true, frontendRoot: 'D:/fe', rawUrl: undefined });
  assert.equal(dev.kind, 'url');
  assert.equal(dev.value, `${ORIGIN}/${entryPage}`, '开发态入口页名必须来自 DEV_ENDPOINT.entryPage');
  assert.equal(path.posix.basename(dev.value), entryPage);

  const dist = petWindow.resolveEntrySpec({ isDev: false, frontendRoot: 'D:/fe', rawUrl: undefined });
  assert.equal(dist.kind, 'file');
  assert.equal(path.basename(dist.value), entryPage, '打包态入口页名必须来自 DEV_ENDPOINT.entryPage');
  assert.equal(path.basename(path.dirname(dist.value)), 'dist');
  assert.equal(dist.value, path.join('D:/fe', 'dist', entryPage));

  // 显式的 ELECTRON_URL 只影响 origin，不影响入口页名
  const custom = petWindow.resolveEntrySpec({ isDev: true, frontendRoot: 'D:/fe', rawUrl: `${ORIGIN} ` });
  assert.equal(custom.value, `${ORIGIN}/${entryPage}`);
  assert.equal(petWindow.PET_ENTRY_PAGE, entryPage, 'PET_ENTRY_PAGE 必须是真源入口页名的别名');
});

test('入口页（K4）：打包态缺少 frontendRoot 时抛错而不是拼出畸形路径', () => {
  assert.throws(() => petWindow.resolveEntrySpec({ isDev: false, frontendRoot: '', rawUrl: '' }), TypeError);
  assert.throws(() => petWindow.resolveEntrySpec({ isDev: false, frontendRoot: '   ', rawUrl: '' }), TypeError);
  assert.throws(() => petWindow.resolveEntrySpec({ isDev: false, rawUrl: '' }), TypeError);
});

test('对外接口兼容：registerPetWindow / resolveDevEntryUrl / DEV_ENTRY_FALLBACK 都还在', () => {
  assert.equal(typeof petWindow.registerPetWindow, 'function');
  assert.equal(typeof petWindow.resolveDevEntryUrl, 'function');
  assert.equal(typeof petWindow.resolveEntrySpec, 'function');
  assert.equal(typeof petWindow.DEV_ENTRY_FALLBACK, 'string');
  assert.equal(petWindow.DEV_ENTRY_FALLBACK, ORIGIN);
});

test('入口 URL：未设置时回退默认端口', () => {
  assert.equal(resolveDevEntryUrl(undefined), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl(null), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl(''), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl('   '), `${DEV_ENTRY_FALLBACK}/`);
});

test('入口 URL：尾随空格（历史缺陷）不再抛 Invalid URL', () => {
  assert.doesNotThrow(() => resolveDevEntryUrl(`${ORIGIN} `));
  assert.equal(resolveDevEntryUrl(`${ORIGIN} `), `${ORIGIN}/`);
});

test('入口 URL：兜底地址取自桌宠端点真源，不再是主应用端口', () => {
  assert.equal(DEV_ENTRY_FALLBACK, ORIGIN);
  assert.equal(resolveDevEntryUrl(''), `${ORIGIN}/`);
});

test('入口 URL：合法地址补上结尾斜杠，可直接拼 pet.html', () => {
  assert.equal(resolveDevEntryUrl(ORIGIN), `${ORIGIN}/`);
  assert.equal(resolveDevEntryUrl(`${ORIGIN}/`), `${ORIGIN}/`);
  assert.equal(new URL('pet.html', resolveDevEntryUrl(ORIGIN)).toString(), `${ORIGIN}/pet.html`);
});

test('入口 URL：带引号的值（set "VAR=..." 的另一种写法）也能解析', () => {
  assert.equal(resolveDevEntryUrl(`"${ORIGIN}"`), `${ORIGIN}/`);
});

test('入口 URL：非法值与非法协议一律降级，不抛错', () => {
  assert.equal(resolveDevEntryUrl('not a url'), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl(`ftp://127.0.0.1:${PORT}/`), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl('file:///C:/tmp/'), `${DEV_ENTRY_FALLBACK}/`);
});
