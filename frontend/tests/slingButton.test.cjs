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

test('ChatInputSendButton 统一为纯净发送与取消按钮样式（去除动画，蓝底白右箭头，红框内阴影白方块）', () => {
  const sendButtonPath = path.resolve(__dirname, '../src/components/chat/ChatInputSendButton.vue');
  assert.equal(fs.existsSync(sendButtonPath), true, '未找到 ChatInputSendButton.vue 文件');
  const source = fs.readFileSync(sendButtonPath, 'utf8');

  // 1. 去除弹弓与图标变形动画，采用标准按钮
  assert.doesNotMatch(source, /import SlingButton/, '已去除按钮动画，不应再导入 SlingButton');
  assert.doesNotMatch(source, /import MorphingSendIcon/, '已去除图标变形动画，不应再导入 MorphingSendIcon');
  assert.match(source, /<button[\s\S]*?data-slot="send-button"/, '未保留 data-slot="send-button" 插槽标识');

  // 2. 发送状态：蓝色背景，白色箭头 (->) 向右
  assert.match(source, /props\.armed\s*\?\s*['"][^'"]*bg-blue-600/, '发送就绪状态必须配置 bg-blue-600 蓝色背景');
  assert.match(source, /<svg[\s\S]*?class="[^"]*text-white[^"]*"[\s\S]*?>/, '发送状态图标必须为白色');
  assert.match(source, /<path d="M5 12h14" \/>\s*<path d="m13 6 6 6-6 6" \/>/, '发送状态必须为白色向右箭头 (->)');

  // 3. 取消状态：红色边框，向内阴影，白色小方块居中
  assert.match(source, /border-red-500/, '取消状态必须具备红色边框');
  assert.match(source, /shadow-\[inset_0_1px_4px_rgba\(239,68,68,0\.4\)\]|shadow-inner/, '取消状态必须具备向内阴影');
  assert.match(source, /class="[^"]*bg-white[^"]*"[^>]*aria-hidden="true"/, '取消状态未包含白色小方块');

  // 4. 交互与状态绑定：禁用与发送/停止事件
  assert.match(source, /:disabled="!(?:props\.)?armed"/, '未绑定 disabled 属性到 armed 状态');
  assert.match(source, /@click="(?:props\.)?onSend"/, '未绑定 click 事件到 onSend 回调');
});
