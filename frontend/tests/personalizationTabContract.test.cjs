/**
 * 个性化设置面板布局与交互契约守卫。
 *
 * 验证重点：
 * 1. 保存底栏不得使用 sticky 或 bottom-0，避免表单拉高滚动时悬浮遮挡自定义指令内容；
 * 2. 自定义指令输入框必须限制最大高度并声明只读防拉伸，避免拖拽溢出破坏卡片布局。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const tabSource = stripComments(read('src/views/settings/tabs/PersonalizationTab.vue'));

test('保存底栏不得包含 sticky 悬浮定位，防止拉高时遮挡输入框正文', () => {
  assert.doesNotMatch(
    tabSource,
    /sticky\s+bottom-0/,
    '保存底栏不能使用 sticky bottom-0 悬浮覆盖，必须跟随在卡片下方文档流中'
  );
});

test('自定义指令文本框需限制最大高度并区分只读与编辑态 resize', () => {
  assert.match(
    tabSource,
    /max-h-/,
    '自定义指令文本框必须设置 max-h-* 限制拉伸上限'
  );
  assert.match(
    tabSource,
    /resize-none/,
    '非编辑只读状态下必须禁用 resize-none 防止误拉伸变形'
  );
  assert.match(
    tabSource,
    /resize-y/,
    '编辑状态下允许受限的垂直拉伸 resize-y'
  );
});
