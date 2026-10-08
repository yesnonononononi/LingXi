/**
 * Block 契约投影守卫（P3）。
 *
 * <p>钉住两条不变量：</p>
 * <ol>
 *   <li><b>块 → 气泡的落点由后端 type/placement 唯一决定</b>：THINKING→thoughtSteps、
 *       TEXT+PROCESS→aiMessages、TEXT+BODY→content、TOOL→toolCalls；顺序全来自 {@code order}。</li>
 *   <li><b>增量按 blockId 覆盖而非版本比较</b>：同一 blockId 的第二次 upsert 必须替换掉第一次，
 *       即使 viewVersion 未变（工具收尾不改 chat_turn，版本号相等是合法情形）。</li>
 * </ol>
 *
 * <p>这两条正是「删掉前端自造 order / 内容指纹去重」的前提 —— 前提不成立就不能删旧逻辑。</p>
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Block, TurnViewVO } from '../src/types/block';
import { projectTurnView, upsertBlockIntoBubble } from '../src/views/chat/blockProjection';
import type { ChatMessage } from '../src/types/chat';

function bubble(): ChatMessage {
  return { id: 'b1', role: 'assistant', content: '', timestamp: 0 };
}

function view(blocks: Block[], viewVersion = 1): TurnViewVO {
  return {
    sessionId: '100',
    turnId: '800',
    status: 'RUNNING',
    viewVersion,
    blocks,
  };
}

const thinking = (order: number): Block => ({
  blockId: 'thinking:r1', type: 'THINKING', order, status: 'DONE', content: '想一下',
});
const processText = (order: number): Block => ({
  blockId: 'text:r1', type: 'TEXT', order, status: 'DONE', placement: 'PROCESS', content: '中途叙述',
});
const bodyText = (order: number): Block => ({
  blockId: 'text:r2', type: 'TEXT', order, status: 'DONE', placement: 'BODY', content: '结论正文',
});
const tool = (order: number, status: Block['status'] = 'DONE'): Block => ({
  blockId: 'tool:call-1', type: 'TOOL', order, status, toolCallId: 'call-1', toolName: 'read_file',
});

test('四种块各归其位，正文与过程分离', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0), processText(1), tool(2), bodyText(3000)]));

  assert.equal(b.thoughtSteps?.length, 1, '思考块进 thoughtSteps');
  assert.equal(b.aiMessages?.length, 1, 'PROCESS 正文进 aiMessages');
  assert.equal(b.toolCalls?.length, 1, '工具块进 toolCalls');
  assert.equal(b.content, '结论正文', 'BODY 正文进气泡 content');
});

test('顺序由后端 order 决定，与传入顺序无关', () => {
  const b = bubble();
  // 故意乱序传入：后端已排好序，前端只是防御性再排一次。
  projectTurnView(b, view([tool(2), thinking(0), processText(1)]));

  const kinds = (b.processTimeline ?? []).map(item => item.type);
  assert.deepEqual(kinds, ['thought', 'intermediate_ai', 'tool'], '时间线必须按 order 升序');
});

test('块状态映射到工具四态：completed≠成功、PROMISED→pending、FAILED→failed', () => {
  const cases: Array<[Block['status'], string]> = [
    ['DONE', 'success'],
    ['FAILED', 'failed'],
    ['REJECTED', 'failed'],
    ['TIMED_OUT', 'failed'],
    ['CANCELLED', 'failed'],
    ['PROMISED', 'pending'],
    ['STREAMING', 'calling'],
  ];
  for (const [status, expected] of cases) {
    const b = bubble();
    projectTurnView(b, view([tool(2, status)]));
    assert.equal(b.toolCalls?.[0].status, expected, `块状态 ${status} 应映射为 ${expected}`);
  }
});

test('重复投影同一视图是幂等的（整体重写，不追加）', () => {
  const b = bubble();
  const v = view([thinking(0), tool(2)]);
  projectTurnView(b, v);
  projectTurnView(b, v);

  assert.equal(b.thoughtSteps?.length, 1, '不能因重复投影而翻倍');
  assert.equal(b.toolCalls?.length, 1);
  assert.equal(b.processTimeline?.length, 2);
});

test('增量按 blockId 覆盖，即使 viewVersion 未变（工具收尾不改 chat_turn）', () => {
  const b = bubble();
  // 先整轮：工具还在跑
  projectTurnView(b, view([thinking(0), tool(2, 'STREAMING')], 5));
  assert.equal(b.toolCalls?.[0].status, 'calling');

  // 再增量：同一 blockId、同一 viewVersion（5），状态翻转为完成
  upsertBlockIntoBubble(b, view([tool(2, 'DONE')], 5));

  assert.equal(b.toolCalls?.length, 1, '同 blockId 必须替换而非追加');
  assert.equal(b.toolCalls?.[0].status, 'success', '版本号相等也必须采纳增量');
  assert.equal(b.thoughtSteps?.length, 1, '未变化的块必须保留');
  assert.equal(b.processTimeline?.length, 2, '时间线同 blockId 也必须替换而非重复');
});

test('增量遇到新 blockId 时追加，不改动其它块', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0)], 5));
  upsertBlockIntoBubble(b, view([tool(2, 'DONE')], 5));

  assert.equal(b.thoughtSteps?.length, 1, '原有思考块保留');
  assert.equal(b.toolCalls?.length, 1, '新块追加');
  assert.equal(b.processTimeline?.length, 2);
});

test('空块增量是空操作（不发空帧语义）', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0)], 5));
  upsertBlockIntoBubble(b, view([], 5));

  assert.equal(b.thoughtSteps?.length, 1);
  assert.equal(b.processTimeline?.length, 1);
});
