/**
 * 弹窗关闭策略的静态契约。
 *
 * 分工：**行为**由 tests/lxModalPolicy.smoke.cjs（真实 Esc / 点遮罩）保证；
 * 这里只锁「结构性约定」——遮罩与关闭策略必须只有一处实现，业务弹窗只能通过 props 声明策略。
 * 两者互补：行为测试证明 LxModal 对，静态测试证明没人绕过 LxModal 另起炉灶。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const lxModal = stripComments(read('src/components/common/LxModal.vue'));
const settings = stripComments(read('src/views/settings/SettingsModal.vue'));
const workspace = stripComments(read('src/components/chat/WorkspaceModal.vue'));
const team = stripComments(read('src/components/chat/TeamModal.vue'));
const confirm = stripComments(read('src/components/common/ConfirmModal.vue'));
const chatView = stripComments(read('src/views/chat/ChatView.vue'));
const host = stripComments(read('src/views/chat/useChatWorkspace.ts'));

const modals = { settings, workspace, team, confirm };

test('LxModal 是遮罩与关闭策略的唯一实现点', () => {
  assert.match(lxModal, /@click\.self="close\('backdrop'\)"/, '遮罩点击关闭必须由 LxModal 统一实现（且只能是 .self）');
  assert.match(lxModal, /role="dialog"/, 'LxModal 必须声明 role=dialog');
  assert.match(lxModal, /aria-modal="true"/, 'LxModal 必须声明 aria-modal');
  assert.match(lxModal, /const shouldListen = props\.open && props\.closeOnEsc/,
    'Esc 闸门应只有一处：监听器是否存在（open && closeOnEsc）');
  assert.match(lxModal, /closeOnBackdrop:\s*true/, 'closeOnBackdrop 默认应为 true');
  assert.match(lxModal, /closeOnEsc:\s*true/, 'closeOnEsc 默认应为 true');
});

test('业务弹窗不得再各自拼遮罩或自行监听 Esc', () => {
  for (const [name, source] of Object.entries(modals)) {
    assert.match(source, /<LxModal/, `${name} 必须使用 LxModal`);
    assert.doesNotMatch(source, /fixed inset-0/, `${name} 仍在自行拼接遮罩层`);
    assert.doesNotMatch(source, /@click\.self/, `${name} 仍在自行处理遮罩点击`);
    // Escape 只允许出现在 LxModal 里；各弹窗自己的 keydown 只能是 Enter 之类的业务键
    assert.doesNotMatch(source, /'Escape'/, `${name} 仍在自行处理 Esc（会与 LxModal 双重触发或各说各话）`);
  }
});

test('设置面板：关闭按钮是唯一入口（两条策略都必须显式关掉）', () => {
  assert.match(settings, /:close-on-backdrop="false"/, '设置面板必须禁用遮罩点击关闭');
  assert.match(settings, /:close-on-esc="false"/, '设置面板必须禁用 Esc 关闭');
  assert.match(settings, /<button[^>]*@click="emit\('close'\)"/, '关闭按钮必须直接 emit close');
  assert.match(settings, /:aria-label="t\('common\.close'\)"/, '关闭按钮缺少可访问名称');
  assert.doesNotMatch(settings, /Escape/, '设置面板不该再出现 Esc 逻辑');
});

test('工作台 / 团队弹窗保持既有行为：点遮罩可关，Esc 不关', () => {
  for (const [name, source] of Object.entries({ workspace, team })) {
    assert.match(source, /:close-on-esc="false"/, `${name} 不应新增 Esc 关闭（此前就没有，属行为变更）`);
    assert.doesNotMatch(source, /:close-on-backdrop="false"/, `${name} 的遮罩点击关闭不应被关掉`);
  }
});

test('确认弹窗：Esc 交给 LxModal，自身只保留 Enter', () => {
  assert.match(confirm, /transition-name="lx-modal"/, '确认弹窗应保留淡入淡出过渡');
  assert.match(confirm, /@close="handleCancel"/, 'LxModal 的 close 必须接到 handleCancel');
  assert.match(confirm, /'Enter'/, '确认弹窗仍需 Enter 确认');
  assert.doesNotMatch(confirm, /'Escape'/, 'Esc 不应在确认弹窗内重复处理（否则与 LxModal 双重触发）');
});

test('设置面板的 close 事件仍被宿主接成关闭动作', () => {
  assert.match(chatView, /@close="handleCloseSettings"/, 'ChatView 必须继续监听 SettingsModal 的 close');
  assert.match(host, /handleCloseSettings\s*=\s*\(\)\s*=>\s*\{\s*isSettingsOpen\.value\s*=\s*false;/,
    'handleCloseSettings 必须把 isSettingsOpen 置 false');
});
