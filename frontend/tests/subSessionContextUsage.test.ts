import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextUsageText, resolveContextRingDash } from '../src/views/chat/contextUsagePresentation';
import { setPreference } from '../src/i18n';

setPreference('zh-CN');

test('沿用输入区的百分比、K 单位和上下文文案', () => {
  assert.equal(resolveContextUsageText({ usedTokens: 203200, maxTokens: 258000 }), '78.8% · 203.2K / 258.0K 上下文已使用');
  assert.equal(resolveContextUsageText({ usedTokens: 800, maxTokens: 1000 }), '80.0% · 800 / 1.0K 上下文已使用');
});

test('未采集时隐藏，缺少窗口上限时不编造分母和比例', () => {
  for (const usage of [undefined, null, {}, { usedTokens: 0 }]) assert.equal(resolveContextUsageText(usage), '');
  assert.equal(resolveContextUsageText({ usedTokens: 1200 }), '1.2K 上下文已使用');
});

test('深度压缩显示压缩中，本地剪枝不闪烁压缩标签', () => {
  const usage = { usedTokens: 1000, maxTokens: 2000, phase: 'SQUEEZE_STARTED', band: 'SUMMARY' };
  assert.match(resolveContextUsageText(usage), /压缩/);
  assert.doesNotMatch(resolveContextUsageText({ ...usage, band: 'PRUNE' }), /压缩/);
});

test('圆环与既有半径一致，超限文案保留真实比例但绘图封顶', () => {
  const circumference = 2 * Math.PI * 6;
  assert.equal(resolveContextRingDash({ usedTokens: 1000, maxTokens: 2000 }), `${circumference / 2} ${circumference / 2}`);
  assert.equal(resolveContextRingDash({ usedTokens: 3000, maxTokens: 2000 }), `${circumference} 0`);
  assert.match(resolveContextUsageText({ usedTokens: 3000, maxTokens: 2000 }), /^150.0%/);
  assert.equal(resolveContextRingDash(undefined), `0 ${circumference}`);
});
