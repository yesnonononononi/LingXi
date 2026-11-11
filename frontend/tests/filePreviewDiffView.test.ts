import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  FILE_DIFF_VIEWS,
  canUseDiffView,
  isLatestChangeOfCurrentRecord,
  resolveDiffEndpoint
} from '../src/utils/filePreviewDiffView';

const BASE = 'http://127.0.0.1:18080';
const EDIT = {executionId: 'e1', recordId: 'r1'};

test('差异档位恰好三档：本次改动 / 最新改动 / 当前源码', () => {
  assert.deepEqual([...FILE_DIFF_VIEWS], ['turn', 'latest', 'source'],
    '档位是契约：多一档少一档都会让界面与后端入口对不上');
});

test('档位可用性：本次改动要记录定位，最新改动要会话标识，源码永远可用', () => {
  assert.equal(canUseDiffView('turn', {path: '/ws/a.ts'}), false, '普通读文件没有记录定位');
  assert.equal(canUseDiffView('turn', {path: '/ws/a.ts', edit: EDIT}), true);
  assert.equal(canUseDiffView('latest', {path: '/ws/a.ts'}), false, '没有会话就无从界定「这个文件的历史」');
  assert.equal(canUseDiffView('latest', {path: '/ws/a.ts', sessionId: ''}), false, '空串会话同样不可用');
  assert.equal(canUseDiffView('latest', {path: '/ws/a.ts', sessionId: '7'}), true);
  assert.equal(canUseDiffView('latest', {path: '/ws/a.ts', sessionId: 7}), true, '数值会话标识也要认');
  assert.equal(canUseDiffView('source', {path: '/ws/a.ts'}), true);
});

test('地址拼装：本次改动按记录，最新改动按会话 + 文件名，源码不发请求', () => {
  assert.equal(resolveDiffEndpoint('turn', {path: '/ws/a.ts', edit: EDIT}, BASE),
    `${BASE}/a/file-edits/e1/r1`);
  assert.equal(resolveDiffEndpoint('turn', {path: '/ws/a.ts'}, BASE), null);

  const latest = resolveDiffEndpoint('latest', {path: 'D:/工作区/a b.ts', sessionId: '7'}, BASE);
  assert.equal(latest, `${BASE}/a/file-edits/latest/7?path=${encodeURIComponent('D:/工作区/a b.ts')}`,
    '路径必须编码：空格、中文与盘符都要原样到达后端');
  assert.equal(resolveDiffEndpoint('latest', {path: '/ws/a.ts'}, BASE), null);

  assert.equal(resolveDiffEndpoint('source', {path: '/ws/a.ts', edit: EDIT}, BASE), null,
    '源码由主进程读磁盘，走后端就是错的');
});

test('「最新改动」是否就是当前这条记录：相同要能识别出来', () => {
  assert.equal(isLatestChangeOfCurrentRecord(EDIT, {executionId: 'e1', recordId: 'r1'}), true);
  assert.equal(isLatestChangeOfCurrentRecord(EDIT, {executionId: 'e2', recordId: 'r9'}), false,
    '不同轮次的记录不能被当成同一条');
  assert.equal(isLatestChangeOfCurrentRecord(EDIT, {executionId: 'e1'}), false);
  assert.equal(isLatestChangeOfCurrentRecord(null, {executionId: 'e1', recordId: 'r1'}), false);
  assert.equal(isLatestChangeOfCurrentRecord(EDIT, null), false);
});

/**
 * 面板不得自己拼端点。
 *
 * <p>曾经 `editEndpoint` 在组件里内联拼过一份 URL，档位一多就是两套口径；现在只有
 * `utils/filePreviewDiffView.ts` 认识 `/a/file-edits`，组件只调它。</p>
 */
test('预览面板把端点拼装委托给 utils，组件里不再出现裸接口路径', () => {
  const source = readFileSync(new URL('../src/components/chat/FilePreviewPanel.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/a\/file-edits\//, '组件里出现接口字面量就是第二份口径');
  assert.match(source, /resolveDiffEndpoint\('turn'/, '本次改动的地址必须来自 utils');
  assert.match(source, /setDiffView\('latest'\)/, '切到最新改动要走同一个入口');
});
