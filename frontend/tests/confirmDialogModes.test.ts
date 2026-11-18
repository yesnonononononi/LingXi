import test from 'node:test';
import assert from 'node:assert/strict';
import {useConfirm} from '../src/composables/useConfirm';

/**
 * 弹窗三态的唯一实现点：`confirm`（问 yes/no）、`notice`（只说一句）、`busy`（进行中，不可关闭）。
 *
 * <p>本轮的技术债就是「把 `window.alert` 全部换掉」：原生弹窗的标题由 Electron 按 app name 填
 * （历史包名一路漏到用户脸上）、样式与主题脱钩、阻塞渲染。要换干净就得先保证替代品在这三种
 * 语义上各自正确 —— 尤其是 `busy`：它被用来包住整树删除 / 整库清空，一旦能被 Enter 或 Esc
 * 关掉，用户会以为操作被取消了，而后端其实还在删。</p>
 */

const { state, confirm, notice, busy, handleConfirm, handleCancel } = useConfirm();

test('notice：只有一个确认按钮，关掉后 promise 结束', async () => {
  const pending = notice('删除会话失败，请重试');
  assert.equal(state.value.isOpen, true);
  assert.equal(state.value.options.showCancel, false, '提示框不该给「取消」');
  assert.equal(state.value.options.content, '删除会话失败，请重试');
  assert.equal(state.value.options.loading, undefined, '提示框不是进行中态');

  handleConfirm();
  await pending;
  assert.equal(state.value.isOpen, false);
});

test('notice 也接受对象形式（带 title / type）', async () => {
  const pending = notice({content: '会话仍在执行中，请先停止后再删除', type: 'warning'});
  assert.equal(state.value.options.type, 'warning');
  assert.equal(state.value.options.showCancel, false);
  handleConfirm();
  await pending;
});

test('busy：不显示按钮，Enter / Esc（handleConfirm / handleCancel）都关不掉', () => {
  const close = busy({content: '正在清空全部对话…'});
  assert.equal(state.value.isOpen, true);
  assert.equal(state.value.options.loading, true);
  assert.equal(state.value.options.showCancel, false, '进行中态连取消都不该有');
  assert.equal(state.value.resolve, null, '进行中态没有「结果」可言，不该留悬空 resolve');

  handleConfirm();
  assert.equal(state.value.isOpen, true, 'Enter 不能把进行中弹窗确认掉');
  handleCancel();
  assert.equal(state.value.isOpen, true, 'Esc / 遮罩点击不能把进行中弹窗关掉');

  close();
  assert.equal(state.value.isOpen, false, '只有调用方的关闭函数能收掉它');
});

test('busy 关闭后可以再次打开普通确认框（不留残留状态）', async () => {
  const close = busy('正在删除会话…');
  close();
  assert.equal(state.value.isOpen, false);

  const pending = confirm('确认删除该会话？');
  assert.equal(state.value.isOpen, true);
  assert.equal(state.value.options.loading, undefined, '进行中标记不能漏到下一个弹窗');
  assert.equal(state.value.options.showCancel, true);
  handleCancel();
  assert.equal(await pending, false);
});

test('confirm 仍然返回布尔结果（未回归）', async () => {
  const yes = confirm('确认清空？');
  handleConfirm();
  assert.equal(await yes, true);
});
