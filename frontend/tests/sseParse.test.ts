import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseBlock, readSseStream } from '../src/services/sse';

test('解析事件名与 JSON 事件体', () => {
  const evt = parseSseBlock('event: PARTIAL_TEXT\ndata: {"content":"你"}');
  assert.ok(evt);
  assert.equal(evt.event, 'PARTIAL_TEXT');
  assert.deepEqual(evt.data, { content: '你' });
  assert.equal(evt.raw, '{"content":"你"}');
});

test('纯心跳注释块不产出事件', () => {
  assert.equal(parseSseBlock(':ping'), null);
  assert.equal(parseSseBlock(': keep-alive'), null);
});

test('没有 data 行的块不产出事件', () => {
  assert.equal(parseSseBlock('event: EXECUTION_STARTED'), null);
});

test('event 缺省时按规范回退为 message', () => {
  const evt = parseSseBlock('data: {"a":1}');
  assert.ok(evt);
  assert.equal(evt.event, 'message');
});

test('data 非 JSON 时保留原文且 data 为 null', () => {
  const evt = parseSseBlock('event: X\ndata: not-json');
  assert.ok(evt);
  assert.equal(evt.data, null);
  assert.equal(evt.raw, 'not-json');
});

test('多行 data 以换行拼接', () => {
  const evt = parseSseBlock('event: X\ndata: line1\ndata: line2');
  assert.ok(evt);
  assert.equal(evt.raw, 'line1\nline2');
});

test('冒号后仅吃掉一个空格，多余空格属于数据', () => {
  const evt = parseSseBlock('event:MSD\ndata:  {"content":"x"}');
  assert.ok(evt);
  assert.equal(evt.event, 'MSD');
  // data 冒号后是「两个空格再加 {」，吃掉一个后剩一个空格
  assert.equal(evt.raw, ' {"content":"x"}');
});

/** 造一个按块推送的假 ReadableStream，验证跨 chunk 缓冲与中止行为。 */
function fakeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  return { body: stream } as unknown as Response;
}

test('readSseStream 跨 chunk 拼接半截事件', async () => {
  const events: string[] = [];
  // 一个事件被网络从中间切开：第二块以「半截」开头。
  const res = fakeSseResponse([
    'event: PARTIAL_TEXT\ndata: {"content":"你',
    '好"}\n\nevent: COMPLETE_TEXT\ndata: {"content":"你好"}\n\n',
  ]);
  await readSseStream(res, {
    onEvent: (e) => events.push(e.event),
  });
  assert.deepEqual(events, ['PARTIAL_TEXT', 'COMPLETE_TEXT']);
});

test('readSseStream 以 onDone 收尾而非 onError', async () => {
  let done = false;
  let errored = false;
  const res = fakeSseResponse(['event: X\ndata: 1\n\n']);
  await readSseStream(res, {
    onEvent: () => {},
    onDone: () => { done = true; },
    onError: () => { errored = true; },
  });
  assert.equal(done, true);
  assert.equal(errored, false);
});

test('readSseStream 主动 abort 不触发 onError', async () => {
  const controller = new AbortController();
  let errored = false;
  let received = 0;
  const res = fakeSseResponse(['event: X\ndata: 1\n\n', 'event: Y\ndata: 2\n\n']);
  const reading = readSseStream(res, {
    signal: controller.signal,
    onEvent: () => { received++; controller.abort(); },
    onError: () => { errored = true; },
  });
  await reading;
  assert.equal(errored, false);
  assert.equal(received, 1);
});
