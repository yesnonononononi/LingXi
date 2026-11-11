import assert from 'node:assert/strict';
import test from 'node:test';

import {buildTurnFileChangeRows, turnFileChangeTotals} from '../src/utils/turnFileChanges';
import {toFilePreviewIpcRequest} from '../src/types/filePreview';

test('buildTurnFileChangeRows：同一文件已被后端合并成一条，前端只投影不累加', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: '/ws/src/a.ts', plusLines: 5, minusLines: 2, edits: 3, created: false,
      executionId: 'e1', recordId: 'r1', diffAvailable: true},
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'a.ts');
  assert.equal(rows[0].dir, '/ws/src');
  // 数字原样透出：再「帮后端加一次」会把改过去又改回来的场景记成 +2/−2。
  assert.equal(rows[0].plusLines, 5);
  assert.equal(rows[0].minusLines, 2);
  assert.deepEqual(rows[0].edit, {executionId: 'e1', recordId: 'r1'});
});

test('buildTurnFileChangeRows：diffAvailable 为假的轮次该行不可点开', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'a.ts', plusLines: 1, minusLines: 0, edits: 1, created: false,
      executionId: 'e1', recordId: 'r1', diffAvailable: false},
  ]);

  assert.equal(rows[0].edit, null, '历史轮次只给行数，不能点开差异');
});

test('buildTurnFileChangeRows：缺执行或记录标识时该行不可点开差异', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'a.ts', plusLines: 1, minusLines: 0, edits: 1, created: false,
      executionId: 'e1', diffAvailable: true},
    {filePath: 'b.ts', plusLines: 1, minusLines: 0, edits: 1, created: false,
      recordId: 'r1', diffAvailable: true},
  ]);

  assert.equal(rows[0].edit, null, '只有 executionId 无法定位记录');
  assert.equal(rows[1].edit, null, '只有 recordId 无法定位记录');
});

test('buildTurnFileChangeRows：Windows 反斜杠路径也能拆出文件名', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'D:\\repo\\src\\b.vue', plusLines: 0, minusLines: 3, edits: 1, created: false},
  ]);

  assert.equal(rows[0].name, 'b.vue');
  assert.equal(rows[0].dir, 'D:/repo/src');
});

test('buildTurnFileChangeRows：根级文件没有目录副文案，缺失字段按 0 而非 NaN', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'README.md', plusLines: 0, minusLines: 0, edits: 0, created: false},
  ]);

  assert.equal(rows[0].name, 'README.md');
  assert.equal(rows[0].dir, '');
  assert.equal(rows[0].plusLines, 0);
  assert.equal(rows[0].minusLines, 0);
  assert.equal(rows[0].edits, 0);
  assert.equal(rows[0].created, false);
  assert.equal(rows[0].edit, null);
});

test('buildTurnFileChangeRows：空输入返回空数组', () => {
  assert.deepEqual(buildTurnFileChangeRows(null), []);
  assert.deepEqual(buildTurnFileChangeRows(undefined), []);
  assert.deepEqual(buildTurnFileChangeRows([]), []);
});

test('turnFileChangeTotals：逐行相加得到全轮合计', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'a.ts', plusLines: 5, minusLines: 2, edits: 1, created: false},
    {filePath: 'b.ts', plusLines: 1, minusLines: 4, edits: 1, created: false},
  ]);

  assert.deepEqual(turnFileChangeTotals(rows), {plusLines: 6, minusLines: 6});
});

test('toFilePreviewIpcRequest：跨界载荷必须是可结构化克隆的纯对象', () => {
  // 回归守卫：曾用 {...tab.request} 浅拷贝，嵌套的 edit 仍是响应式 Proxy，
  // IPC 直接以 "An object could not be cloned." 失败；主进程也从不读 edit。
  const reactiveLike = {executionId: 'e1', recordId: 'r1'};
  const request = {
    sessionId: '7',
    path: 'D:/ws/index.html',
    baseUrl: 'http://localhost:8088',
    watchKey: 'k1',
    edit: reactiveLike
  };

  const payload = toFilePreviewIpcRequest(request);

  assert.deepEqual(Object.keys(payload).sort(), ['baseUrl', 'path', 'sessionId', 'watchKey']);
  assert.equal(payload.edit, undefined, 'edit 是渲染态，不该跨界');
  assert.doesNotThrow(() => structuredClone(payload), '载荷必须能被结构化克隆');
});

test('toFilePreviewIpcRequest：渲染态带 Proxy 时载荷仍可克隆', async () => {
  const {ref} = await import('vue');
  const tabs = ref([{sessionId: '7', path: 'a.ts', baseUrl: 'http://localhost:8088',
    watchKey: 'k1', edit: {executionId: 'e1', recordId: 'r1'}}]);

  const payload = toFilePreviewIpcRequest(tabs.value[0]!);

  // 整对象透传会抛 DataCloneError，这正是线上那条报错的来源。
  assert.throws(() => structuredClone(tabs.value[0]), 'Proxy 透传必然被克隆拒绝');
  assert.doesNotThrow(() => structuredClone(payload));
  assert.equal(payload.path, 'a.ts');
});

