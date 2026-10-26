/**
 * 空取消轮的落点守卫。
 *
 * 背景（真实缺陷，别把测试删了）：模型还没输出第一个 token 就被停止时，该轮
 * `blocks` 为空、状态 CANCELLED。历史投影把「空块 + 终态」整轮跳过（原本是为 FAILED
 * 保留的：交给 synthesizeFailedTurnBubbles 用 errorReason 合成），取消轮又不带 errorReason
 * ⇒ 一条 assistant 行都没有 ⇒ 用户气泡下面纯空白，看起来像回答丢了。
 *
 * 修法：**每个轮次都建 assistant 行**（含空块终态），并让空终态走**普通轮的底栏**
 * （状态 / 用量 / 耗时 / 开始时间）——不要再单独画一行提示：`isTerminalTurn`
 * 只负责放开 `isMessageCompleted` 的「必须有内容」闸门。终态原因由 `turn.errorReason` 提供，
 * 不往 content 里拼字（正文每次投影都会重算，拼进去会被抹掉）。
 * 本测试覆盖 ① 投影语义 ② 状态复位 ③ 渲染接线（源级，防止闸门被改回去）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBubbleFromTurnView, projectTurnView, upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';

const SESSION_ID = '2111800762467237888';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');

function view(overrides: Partial<TurnViewVO>): TurnViewVO {
  return {
    sessionId: SESSION_ID,
    turnId: '2111802604660080640',
    status: 'CANCELLED',
    viewVersion: '1',
    userMessage: '1',
    blocks: [],
    ...overrides,
  } as TurnViewVO;
}

function project(views: TurnViewVO[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of views) upsertTurnViewIntoMessages(messages, item);
  return messages;
}

test('空取消轮：必须留下可渲染的 assistant 行，并标记为已取消', () => {
  // 变异：把 upsertTurnViewIntoMessages 的早退条件改回「FAILED || CANCELLED」→ 只剩 1 条，本测试红
  const messages = project([view({})]);

  assert.equal(messages.length, 2, '用户气泡 + 取消落点，缺一个界面就一片空白');
  const bubble = messages.find(m => m.role === 'assistant');
  assert.ok(bubble, '必须建 assistant 行');
  assert.equal(bubble!.turnId, '2111802604660080640');
  assert.equal(bubble!.cancelled, true, '必须标记取消，渲染层据此出「已取消」行');
  assert.equal(bubble!.isComplete, true, '终态必须收尾，否则会一直转圈');
  assert.equal(bubble!.content, '', '不得给取消轮拼假正文（那不是模型输出）');
});

test('空失败轮：同样留下 assistant 行，并标记失败（原因取自轮次摘要）', () => {
  // 变异：把「空块终态也建行」改回早退 → 只剩 1 条，失败轮又变回空白。
  const messages = project([view({ status: 'FAILED' })]);

  assert.equal(messages.length, 2, '失败轮也要有可挂「已失败」的 assistant 行');
  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.failed, true);
  assert.equal(bubble.cancelled, false);
  assert.equal(bubble.content, '', '失败原因不进正文（会被下一次投影重算抹掉）');
});

test('取消后再收到运行/完成快照，取消标记必须复位', () => {
  const bubble = buildBubbleFromTurnView(view({}));
  assert.equal(bubble.cancelled, true);

  projectTurnView(bubble, view({ status: 'COMPLETED' }));
  assert.equal(bubble.cancelled, false, '恢复后的轮次不得继续顶着「已取消」');
});

test('有内容的取消轮同样带标记（渲染层只对「确实空」的组插行）', () => {
  const messages = project([view({
    blocks: [{ blockId: 'text:1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '半截回答' }],
  })]);
  const bubble = messages.find(m => m.role === 'assistant')!;

  assert.equal(bubble.cancelled, true);
  assert.equal(bubble.content, '半截回答', '取消不吞已产出的正文');
});

test('★ 渲染接线：空终态轮必须走普通轮的底栏（状态 / 用量 / 耗时 / 开始时间）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src/components/chat/ChatMessageItem.vue'), 'utf8');

  // 底栏的闸门：空终态必须有内容以外的放行条件，否则这轮什么都不显示
  assert.match(src, /isTerminalTurn/, '缺少终态判据 ⇒ 底栏不渲染，整轮不可见');
  assert.match(src, /if \(isTerminalTurn\.value\) \{\s*return true;/, '终态必须放行 isMessageCompleted');
  assert.match(src, /props\.message\.cancelled === true \|\| props\.message\.failed === true/,
    '判据必须读气泡标记（轮次摘要可能尚未到达）');
  // 不再单独画一行提示：样式与普通轮统一，量化的东西交给底栏
  assert.doesNotMatch(src, /terminal-empty-turn/, '自定义提示行已废弃 —— 统一用底栏');
  // 开始时间取权威轮次摘要，而不是历史投影的 Date.now() 兜底
  assert.match(src, /props\.turn\?\.startedAt/, '开始时间必须取 turn.startedAt');
});
