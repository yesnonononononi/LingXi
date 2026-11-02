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

test('入口 URL：未设置时回退默认端口', () => {
  assert.equal(resolveDevEntryUrl(undefined), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl(null), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl(''), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl('   '), `${DEV_ENTRY_FALLBACK}/`);
});

test('入口 URL：尾随空格（历史缺陷）不再抛 Invalid URL', () => {
  assert.doesNotThrow(() => resolveDevEntryUrl('http://127.0.0.1:5174 '));
  assert.equal(resolveDevEntryUrl('http://127.0.0.1:5174 '), 'http://127.0.0.1:5174/');
});

test('入口 URL：合法地址补上结尾斜杠，可直接拼 pet.html', () => {
  assert.equal(resolveDevEntryUrl('http://127.0.0.1:5175'), 'http://127.0.0.1:5175/');
  assert.equal(resolveDevEntryUrl('http://127.0.0.1:5175/'), 'http://127.0.0.1:5175/');
  assert.equal(new URL('pet.html', resolveDevEntryUrl('http://127.0.0.1:5175')).toString(), 'http://127.0.0.1:5175/pet.html');
});

test('入口 URL：带引号的值（set "VAR=..." 的另一种写法）也能解析', () => {
  assert.equal(resolveDevEntryUrl('"http://127.0.0.1:5175"'), 'http://127.0.0.1:5175/');
});

test('入口 URL：非法值与非法协议一律降级，不抛错', () => {
  assert.equal(resolveDevEntryUrl('not a url'), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl('ftp://127.0.0.1:5175/'), `${DEV_ENTRY_FALLBACK}/`);
  assert.equal(resolveDevEntryUrl('file:///C:/tmp/'), `${DEV_ENTRY_FALLBACK}/`);
});
