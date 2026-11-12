import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_FILE_LINE_ATTR,
  LOCAL_FILE_LINE_BADGE_ATTR,
  LOCAL_FILE_LINK_CLASS,
  LOCAL_FILE_PATH_ATTR,
  formatLocalFileLocation,
  mentionsLine,
  parseLocalFileLink
} from '../src/utils/localFileLink';

test('本地绝对路径链接：盘符路径、前导斜杠写法与行号', () => {
  // 用户/模型最常见的写法：Markdown 里给绝对路径补一个前导斜杠。
  assert.deepEqual(parseLocalFileLink('/D:/Code/LingXi/frontend/electron/file-preview.cjs:34'),
    { path: 'D:/Code/LingXi/frontend/electron/file-preview.cjs', line: 34 });
  assert.deepEqual(parseLocalFileLink('D:/Code/LingXi/a.md'), { path: 'D:/Code/LingXi/a.md' });
  assert.deepEqual(parseLocalFileLink('/home/summit/a.py:7'), { path: '/home/summit/a.py', line: 7 });
});

test('Windows 反斜杠路径：markdown-it 会百分号编码，解析要还原', () => {
  assert.deepEqual(parseLocalFileLink('C:%5CUsers%5Csummit%5Ca.cjs:34'),
    { path: 'C:\\Users\\summit\\a.cjs', line: 34 });
  assert.deepEqual(parseLocalFileLink('/D:/a%20b/x.cjs:1'), { path: 'D:/a b/x.cjs', line: 1 });
});

test('非本地路径保持普通链接：Web、协议相对、相对路径都不接管', () => {
  for (const href of ['https://example.com/a', 'http://example.com:8080/a', '//example.com/a',
    'mailto:a@b.c', 'src/main/App.java', './a.ts', '', '   ', null, undefined]) {
    assert.equal(parseLocalFileLink(href), undefined, String(href));
  }
});

test('行号必须为正整数：:0 与非法后缀不当作行号', () => {
  assert.deepEqual(parseLocalFileLink('/D:/a.cjs:0'), { path: 'D:/a.cjs' });
  assert.deepEqual(parseLocalFileLink('/D:/a.cjs:'), { path: 'D:/a.cjs:' });
  assert.deepEqual(parseLocalFileLink('/D:/a.cjs:12a'), { path: 'D:/a.cjs:12a' });
});

test('裸百分号不会让整条链接失效', () => {
  assert.deepEqual(parseLocalFileLink('/D:/100%/a.cjs'), { path: 'D:/100%/a.cjs' });
});

test('展示位置与渲染共用同一份类名/属性名，避免两边对不上', () => {
  assert.equal(formatLocalFileLocation({ path: 'D:/a.cjs', line: 34 }), 'D:/a.cjs:34');
  assert.equal(formatLocalFileLocation({ path: 'D:/a.cjs' }), 'D:/a.cjs');
  assert.equal(LOCAL_FILE_LINK_CLASS, 'lx-local-file');
  assert.equal(LOCAL_FILE_PATH_ATTR, 'data-local-file-path');
  assert.equal(LOCAL_FILE_LINE_ATTR, 'data-local-file-line');
  assert.equal(LOCAL_FILE_LINE_BADGE_ATTR, 'data-local-file-line-badge');
});

test('行号徽标：链接文本里已经写了行号就不再补', () => {
  // 模型常见的几种自带写法，都必须算作「已经说了」。
  for (const text of ['预览主进程代码 (line 34)', '第 34 行', '修复位置: 34', 'file.cjs:34']) {
    assert.equal(mentionsLine(text, 34), true, text);
  }
  for (const text of ['预览主进程代码', '第 342 行', '第 3 行', 'line 340']) {
    assert.equal(mentionsLine(text, 34), false, text);
  }
});
