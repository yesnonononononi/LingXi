/**
 * 决策冲突的<b>前端契约守卫</b>：冲突码必须 reject 且 message 等于后端 errMsg。
 *
 * <p><b>为什么单列一个文件</b>：既有前端用例覆盖的是「成功回执怎么渲染」，
 * 从没验证过「后端回 HTTP 200 + body.code=409x 时到底抛不抛」。而
 * {@code ToolCallAPI.decide} 的写法是 {@code if (!isOk(res.code) || !res.data) throw}：
 * 只要有人把它改成 {@code return res.data ?? null} 或吞掉非成功码，用户点「批准」后
 * 界面会静默无反应 —— 卡片没动、也没报错。</p>
 *
 * <p>注入方式是替换 axios 实例的 adapter（本仓既有做法）：断言的是真实
 * {@code ToolCallAPI} 代码路径，不是复制一份判定逻辑来自证。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from '../src/services/interceptor';
import {ToolCallAPI} from '../src/services/toolCall';

/** 装一个只回一份 Result 的 adapter，返回还原函数。 */
function stubResponse(result: unknown) {
  const previous = http.defaults.adapter;
  http.defaults.adapter = async () => ({
    data: result,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  });
  return () => {
    http.defaults.adapter = previous;
  };
}

const decidePayload = {
  conversationId: 9201,
  toolCallId: 'call-conflict',
  commandId: 'cmd-1',
  expectedVersion: 99,
  action: 'APPROVE' as const,
  text: '',
};

test('STATE_CONFLICT(4090)：decide 必须 reject，且 message 就是后端 errMsg', async t => {
  const restore = stubResponse({code: 4090, data: null, errMsg: '卡片已被其他操作更新，请刷新后重试'});
  t.after(restore);

  await assert.rejects(
    () => ToolCallAPI.decide(decidePayload),
    (error: Error) => {
      assert.equal(error.message, '卡片已被其他操作更新，请刷新后重试');
      return true;
    },
    '冲突必须 reject，不能 resolve 成 null',
  );
});

test('DECISION_ALREADY_APPLIED(4091)：decide 不得把「已决」吞成成功', async t => {
  const restore = stubResponse({code: 4091, data: null, errMsg: '该互动已有结论，请查看最新状态'});
  t.after(restore);

  await assert.rejects(
    () => ToolCallAPI.decide(decidePayload),
    (error: Error) => {
      assert.equal(error.message, '该互动已有结论，请查看最新状态');
      return true;
    },
  );
});

test('COMMAND_CONFLICT(4095)：decide 必须 reject 并透出原文案', async t => {
  const restore = stubResponse({
    code: 4095,
    data: null,
    errMsg: '同一命令标识对应了不同的请求内容，请刷新后重新提交',
  });
  t.after(restore);

  await assert.rejects(
    () => ToolCallAPI.decide(decidePayload),
    (error: Error) => {
      assert.equal(error.message, '同一命令标识对应了不同的请求内容，请刷新后重新提交');
      return true;
    },
  );
});

test('answerChoices 遇到冲突码同样 reject，不静默返回空回执', async t => {
  const restore = stubResponse({code: 4090, data: null, errMsg: '卡片已被其他操作更新，请刷新后重试'});
  t.after(restore);

  await assert.rejects(
    () =>
      ToolCallAPI.answerChoices({
        conversationId: 9201,
        commandId: 'cmd-choice',
        expectedGroupVersion: 1,
        answers: [{toolCallId: 'call-conflict', selectedIndexes: [0]}],
      } as never),
    (error: Error) => {
      assert.equal(error.message, '卡片已被其他操作更新，请刷新后重试');
      return true;
    },
  );
});
