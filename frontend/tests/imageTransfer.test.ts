/**
 * `utils/imageTransfer.ts` 的纯逻辑单测：文件名推导 + 取字节的边界。
 *
 * <p>取字节只在 node 里测 `data:` 与不可读地址两条：`blob:` 需要真实浏览器（由
 * `tests/imageContextMenu.smoke.cjs` 在 Electron 里覆盖），这里测的是「大小上限、空内容、
 * 失败要抛中文错误」这些用户真的会撞上的分支。</p>
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  MAX_IMAGE_BYTES,
  readImageBlob,
  readImageBytes,
  resolveImageExtension,
  suggestImageFileName,
} from '../src/utils/imageTransfer';

/** 1x1 PNG 的 data URL。 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAAABgADNjd8qAAAAABJRU5ErkJggg==';

test('IT-1 扩展名按 MIME 取，未知类型退回 png', () => {
  assert.equal(resolveImageExtension('image/png'), 'png');
  assert.equal(resolveImageExtension('image/jpeg'), 'jpg');
  assert.equal(resolveImageExtension('IMAGE/WEBP'), 'webp');
  assert.equal(resolveImageExtension('application/octet-stream'), 'png');
  assert.equal(resolveImageExtension(''), 'png');
});

test('IT-2 文件名推导：取末段、洗非法字符、补扩展名', () => {
  assert.equal(suggestImageFileName('截图', 'image/png'), '截图.png');
  assert.equal(suggestImageFileName('a.jpg', 'image/jpeg'), 'a.jpg', '已经带图片扩展名就不再叠一层');
  assert.equal(suggestImageFileName('C:\\tmp\\shot.jpg', 'image/jpeg'), 'shot.jpg', '路径只取文件名');
  assert.equal(suggestImageFileName('/home/u/shot.png', 'image/png'), 'shot.png');
  assert.equal(suggestImageFileName('a:b?c*d', 'image/png'), 'a_b_c_d.png');
  assert.equal(suggestImageFileName('', 'image/webp'), 'image.webp', '空名字要有兜底');
  assert.equal(suggestImageFileName('   ', 'image/png'), 'image.png');
  assert.equal(suggestImageFileName('../../etc/passwd', 'image/png'), 'passwd.png');
});

test('IT-3 data URL 能读出真实字节', async () => {
  const bytes = await readImageBytes(PNG_DATA_URL);
  assert.ok(bytes.byteLength > 0, '必须读出非空字节');
  const blob = await readImageBlob(PNG_DATA_URL);
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, bytes.byteLength);
});

test('IT-4 读不出来的地址抛中文错误，不返回空字节', async () => {
  await assert.rejects(() => readImageBlob('https://127.0.0.1:1/none.png'), (error: Error) => {
    assert.match(error.message, /无法读取该图片/, '错误文案要说清是读不出来，不能是英文 invalid state');
    return true;
  });
});

test('IT-5 上限常量必须是一个明确的数值（主进程侧同口径）', () => {
  assert.equal(typeof MAX_IMAGE_BYTES, 'number');
  assert.equal(MAX_IMAGE_BYTES, 40 * 1024 * 1024);
});
