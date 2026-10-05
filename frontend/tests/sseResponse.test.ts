import test from 'node:test';
import assert from 'node:assert/strict';
import { readSseResponse } from '../src/utils/sse';
import type { AgentStreamEvent } from '../src/types/chat';

test('HTTP 200 的业务拒绝显示原始原因，不产生回复事件', async () => {
  const response = Response.json({ code: 0, errMsg: '该会话正在执行中' });
  const events: AgentStreamEvent[] = [];

  await assert.rejects(
    readSseResponse(response, { onEvent: event => events.push(event), idleTimeoutMs: 0 }),
    { message: '该会话正在执行中' }
  );
  assert.deepEqual(events, []);
});

test('非成功 HTTP 响应也保留业务原因', async () => {
  const response = Response.json({ code: 0, errMsg: '请先处理待审批事项' }, { status: 409 });

  await assert.rejects(
    readSseResponse(response, { onEvent: () => assert.fail('拒绝响应不能产生事件'), idleTimeoutMs: 0 }),
    { message: '请先处理待审批事项' }
  );
});

test('代理返回 HTML 错误页时显示连接错误，不泄露页面内容', async () => {
  const response = new Response('<html>proxy error</html>', {
    status: 502,
    headers: { 'Content-Type': 'text/html' },
  });

  await assert.rejects(
    readSseResponse(response, { onEvent: () => assert.fail('错误页不能产生事件'), idleTimeoutMs: 0 }),
    { message: '消息流连接失败（HTTP 502），请稍后重试' }
  );
});

test('HTTP 200 的非流响应不能被视为正常完成', async () => {
  const response = Response.json({ code: 1, data: null });

  await assert.rejects(
    readSseResponse(response, { onEvent: () => assert.fail('非流响应不能产生事件'), idleTimeoutMs: 0 }),
    { message: '服务器未返回有效的消息流，请稍后重试' }
  );
});

test('SSE 中的业务拒绝抛出原因，并取消读取', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"code":0,"errMsg":"该会话正在执行中"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=UTF-8' },
  });

  await assert.rejects(
    readSseResponse(response, { onEvent: () => assert.fail('业务拒绝不能产生事件'), idleTimeoutMs: 0 }),
    { message: '该会话正在执行中' }
  );
  assert.equal(cancelled, true);
});

test('SSE 中缺少错误文案时仍明确报错', async () => {
  const response = new Response('data: {"code":0}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });

  await assert.rejects(
    readSseResponse(response, { onEvent: () => assert.fail('业务拒绝不能产生事件'), idleTimeoutMs: 0 }),
    { message: '消息发送失败，请稍后重试' }
  );
});

test('正常 SSE 保留文本事件，只在根会话终态结束', async () => {
  const payloads = [
    { type: 'EXECUTION_STARTED', sessionId: '7' },
    { type: 'PARTIAL_TEXT', sessionId: '7', content: '正在处理' },
    { type: 'EXECUTION_COMPLETED', sessionId: '8' },
    { type: 'EXECUTION_COMPLETED', sessionId: '7' },
    { type: 'PARTIAL_TEXT', sessionId: '7', content: '不应继续读取' },
  ];
  const response = new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream; charset=UTF-8' },
  });
  const events: AgentStreamEvent[] = [];

  await readSseResponse(response, { onEvent: event => events.push(event), idleTimeoutMs: 0 });

  assert.deepEqual(events, payloads.slice(0, 4));
});
