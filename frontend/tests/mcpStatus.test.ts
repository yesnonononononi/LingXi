import test from 'node:test';
import assert from 'node:assert/strict';
import {nextMcpStatus} from '../src/utils/mcpStatus';

/**
 * 行内启停的方向语义（纯函数单测）。
 *
 * <p>方向写反是最容易犯也最难在界面上看出来的缺陷：按钮文字对、请求也发出去了，
 * 只是把用户的停用服务又打开了。所以三个方向各自钉一条断言。</p>
 */

test('已停用（status=0）切换为启用（1）', () => {
  assert.equal(nextMcpStatus(0), 1, '停用的服务点一下必须变成启用，写反就是把停用状态又刷一遍');
});

test('已启用（status=1）切换为停用（0）', () => {
  assert.equal(nextMcpStatus(1), 0, '启用的服务点一下必须变成停用');
});

test('status 缺省按已启用处理，切换结果写 0', () => {
  assert.equal(nextMcpStatus(undefined), 0, '旧数据没带 status 时不得回写 1，否则等于重复启用');
});
