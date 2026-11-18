import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ApiError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  classifyHttpStatus,
  describeKind,
  toApiError,
} from '../src/services/interceptor';

/**
 * 超时必须与「连不上」分开表达。
 *
 * <p>历史缺陷：axios 一刀切的 10s 超时把整树删除 / 整库清空打成「删除失败」，
 * 而服务端其实已经删完（或仍在删）。用户据此反复点击，看到的永远是同一句失败。
 * 这里钉住两件事：默认预算仍是交互请求的预算，且超时不再被误分类为网络失败。</p>
 */

test('默认预算是交互请求的 10s，不得被随手调大冒充长任务预算', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 10_000);
});

test('超时是独立分类，不与网络失败混为一谈', () => {
  const timeout = describeKind('timeout');
  const network = describeKind('network');
  assert.notEqual(timeout, network, '超时与连不上必须给出不同文案');
  assert.match(timeout, /超时/, '超时文案必须说清「超时」');
  assert.match(timeout, /后台/, '超时文案必须提示「操作可能仍在后台继续」，否则用户会以为没发生');
});

test('ApiError 保留超时分类，交给人话解析', () => {
  const error = new ApiError('timeout', describeKind('timeout'));
  assert.equal(error.kind, 'timeout');
  assert.equal(error.message, describeKind('timeout'));
});

test('HTTP 状态分类不受新增分类影响', () => {
  assert.equal(classifyHttpStatus(403), 'forbidden');
  assert.equal(classifyHttpStatus(404), 'notFound');
  assert.equal(classifyHttpStatus(500), 'server');
  assert.equal(classifyHttpStatus(undefined), 'network', '无响应且未判定超时仍归网络');
});

test('axios 的两种超时错误码都归为 timeout，连不上仍是 network', () => {
  for (const code of ['ECONNABORTED', 'ETIMEDOUT']) {
    const error = toApiError(Object.assign(new Error('timeout of 10000ms exceeded'), { code }));
    assert.equal(error.kind, 'timeout', `${code} 必须判成超时，而不是网络连接失败`);
  }
  const refused = toApiError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  assert.equal(refused.kind, 'network', '真正的连不上不能伪装成超时');
});

/**
 * 静态契约：重活必须在 service 层声明自己的预算。
 *
 * <p>不这么做就等于把「数据多」当成「出故障」——而这正是要修的那个技术债。
 * 这里按端点签名锚定，改方法名或丢掉 timeout 选项都会变红。</p>
 */
test('整树删除与整库清空各自声明了独立超时预算', () => {
  const sessionApi = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/services/session.ts'), 'utf8');
  const del = sessionApi.match(/static async del\([\s\S]*?\n  \}/);
  const clear = sessionApi.match(/static async clear\([\s\S]*?\n  \}/);
  assert.ok(del, '未找到 SessionAPI.del，锚点失效');
  assert.ok(clear, '未找到 SessionAPI.clear，锚点失效');

  assert.match(del[0], /timeout:\s*TREE_DELETE_TIMEOUT_MS/, '会话删除必须带自己的超时预算');
  assert.match(clear[0], /timeout:\s*CLEAR_ALL_TIMEOUT_MS/, '整库清空必须带自己的超时预算');
  assert.doesNotMatch(del[0], /DEFAULT_REQUEST_TIMEOUT_MS/, '重活不得回落到交互请求的默认预算');
  assert.doesNotMatch(clear[0], /DEFAULT_REQUEST_TIMEOUT_MS/, '重活不得回落到交互请求的默认预算');
});
