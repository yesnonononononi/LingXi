const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('SlingButton 组件源文件存在且包含完整的弹弓力学与粒子动画', () => {
  const componentPath = path.resolve(__dirname, '../src/components/common/SlingButton.vue');
  assert.equal(fs.existsSync(componentPath), true, '未找到 SlingButton.vue 文件');

  const source = fs.readFileSync(componentPath, 'utf8');

  // 必须包含核心依赖与类型
  assert.match(source, /from '@hugeicons\/core-free-icons'/, '缺少 Hugeicons 图标导入');
  assert.match(source, /from '@hugeicons\/vue'/, '缺少 HugeiconsVue 导入');
  assert.match(source, /from 'motion-v'/, '缺少 motion-v 动画库导入');
  assert.match(source, /export type SlingAxis/, '缺少 SlingAxis 类型导出');
  assert.match(source, /export interface SlingButtonProps/, '缺少 SlingButtonProps 接口导出');

  // 必须具备弹弓力学与粒子发射核心算法
  assert.match(source, /const rubberband\s*=/, '缺少阻尼橡皮筋算法');
  assert.match(source, /const launchDot\s*=/, '缺少粒子发射逻辑');
  assert.match(source, /const paint\s*=/, '缺少手势跟随连线与弧度绘制');
  assert.match(source, /useReducedMotion\(\)/, '必须支持系统减弱动态效果');
});

test('ChatInputArea 正确集成 SlingButton 并映射发送/停止/禁用与主题状态', () => {
  const inputAreaPath = path.resolve(__dirname, '../src/components/chat/ChatInputArea.vue');
  const source = fs.readFileSync(inputAreaPath, 'utf8');

  // 验证组件导入
  assert.match(source, /import SlingButton from '\.\.\/common\/SlingButton\.vue'/, '未导入 SlingButton 组件');

  // 验证模板中的组件渲染与核心 props
  assert.match(source, /<SlingButton[\s\S]*?:pad-color="slingColors\.padColor"/, 'SlingButton 未绑定 pad-color');
  assert.match(source, /:well-color="slingColors\.wellColor"/, 'SlingButton 未绑定 well-color');
  assert.match(source, /:accent-color="slingColors\.accentColor"/, 'SlingButton 未绑定 accent-color');
  assert.match(source, /:disabled="!armed"/, 'SlingButton 未正确绑定 disabled 状态');
  assert.match(source, /@send="onSendClick"/, 'SlingButton 未绑定 send 事件到 onSendClick');
  assert.match(source, /<MorphingSendIcon :is-sending="!!isSending"/, 'SlingButton 插槽未嵌入 MorphingSendIcon');

  // 验证状态色彩映射（发送中为红粉停止色，可用状态为白灰弹弓色，禁用为暗灰）
  assert.match(source, /slingColors = computed/, '缺少 slingColors 状态色彩映射');
  assert.match(source, /#e11d48/, '发送中/停止状态未配置玫瑰红 padColor');
  assert.match(source, /#f5f5f5/, '暗色就绪状态未配置亮白 padColor');
  assert.match(source, /#27272a/, '暗色就绪状态未配置深灰底座 wellColor');
});
