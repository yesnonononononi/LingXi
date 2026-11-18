import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, describeKind, resolveUserFacingMessage} from '../src/services/interceptor';

/**
 * 失败文案的唯一判定点。
 *
 * <p>两个诉求互相拉扯：项目公约要求业务异常消息是**中文业务文案**（该给用户看），
 * 而契约 §7 要求后端 `errMsg` 不得原样渲染（可能含英文、错误码、堆栈）。
 * 判据就落在语言特征上 —— 下面的用例把这个边界钉死。</p>
 */

test('后端中文业务文案原样回显', () => {
  const error = new ApiError('forbidden', describeKind('forbidden'), {
    status: 403,
    rawMessage: '会话仍在执行中，请先停止后再删除',
  });

  assert.equal(resolveUserFacingMessage(error, '兜底文案'), '会话仍在执行中，请先停止后再删除');
});

test('英文/内部异常文案不外泄，退回分类文案', () => {
  const error = new ApiError('forbidden', describeKind('forbidden'), {
    status: 403,
    rawMessage: 'java.lang.IllegalStateException: SessionNoFoundException',
  });

  assert.equal(resolveUserFacingMessage(error, '兜底文案'), describeKind('forbidden'));
});

test('没有 rawMessage 时用分类文案', () => {
  const error = new ApiError('network', describeKind('network'));

  assert.equal(resolveUserFacingMessage(error, '兜底文案'), describeKind('network'));
});

test('非 ApiError（前端自身抛错）一律用调用方兜底，不把内部 message 甩给用户', () => {
  assert.equal(resolveUserFacingMessage(new Error('Cannot read properties of undefined'), '兜底文案'), '兜底文案');
  assert.equal(resolveUserFacingMessage(undefined, '兜底文案'), '兜底文案');
  assert.equal(resolveUserFacingMessage('boom', '兜底文案'), '兜底文案');
});
