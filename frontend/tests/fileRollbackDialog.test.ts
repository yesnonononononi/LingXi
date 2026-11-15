import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * 回滚弹窗的静态契约。
 *
 * <p>弹窗一旦「点了就写盘」，跳过原因就再也没机会被看到；一旦自己编成功状态，用户会以为
 * 文件都回去了。这两件事都没法只靠渲染快照表达，所以直接钉源码里的调用顺序与数据来源。</p>
 */
const source = readFileSync(
  fileURLToPath(new URL('../src/components/chat/FileRollbackDialog.vue', import.meta.url)),
  'utf8'
);

test('回滚弹窗：先 preview 再 rollback，不许合成一次「点了就写盘」', () => {
  const preview = source.indexOf('FileRollbackAPI.preview(');
  const rollback = source.indexOf('FileRollbackAPI.rollback(');
  assert.ok(preview > 0, '弹窗必须调 preview');
  assert.ok(rollback > preview, 'rollback 只能在 preview 之后（源码顺序与调用顺序一致）');
});

test('回滚弹窗：跳过项在确认之前就展示，且带后端给的原因', () => {
  assert.match(source, /data-testid="file-rollback-skipped"/, '跳过分组必须先渲染出来');
  assert.match(source, /\{\{\s*item\.reason\s*\}\}/, '原因取后端文案，前端不自行解释');
  assert.ok(source.indexOf('file-rollback-skipped') < source.indexOf('file-rollback-confirm'),
    '跳过项排在确认按钮之前：先看清再按');
});

test('回滚弹窗：结果只认后端逐文件回执，不做乐观渲染', () => {
  assert.match(source, /response\.data/, '结果必须来自接口回执');
  // 任何「点了就当成功」的写法都会让失败的文件看起来也回去了。
  assert.doesNotMatch(source, /success\s*=\s*true/);
  assert.doesNotMatch(source, /temp-|fake|mock/i, '禁止临时实体/伪造数据');
});

test('回滚弹窗：每次打开都重新拉预览，不复用上一次的计划', () => {
  assert.match(source, /watch\(\(\)\s*=>\s*props\.open/, '打开即重取：预览到确认之间文件可能又被改过');
  assert.match(source, /plan\.value\s*=\s*null/, '重取前必须清掉旧计划，避免闪一帧过期结论');
});
