/**
 * 设置面板的关闭契约：**右上角关闭按钮是唯一关闭入口**。
 *
 * 为什么不是「多余测试」：遮罩点击关闭与 Esc 关闭都是两行就能被「重新加回来」的顺手改动，
 * 而它们造成的伤害是静默的——用户正在 ModelsTab 里填表单，手一滑点到遮罩，半天输入没了。
 * 这条测试就是那道闸：谁把其他关闭入口加回来，谁就在这里变红。
 *
 * 同时锁定反向契约：按钮自己的 emit('close') 不得被删（否则按钮真的形同虚设，且没人会注意到）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

const modal = stripComments(read('src/views/settings/SettingsModal.vue'));
const chatView = stripComments(read('src/views/chat/ChatView.vue'));
const workspace = stripComments(read('src/views/chat/useChatWorkspace.ts'));

test('设置面板不得保留遮罩点击关闭（@click.self → close）', () => {
  assert.doesNotMatch(modal, /@click\.self/, '遮罩点击关闭被加回来了：设置面板只允许关闭按钮承担关闭职责');
});

test('设置面板不得注册 Esc 键关闭', () => {
  assert.doesNotMatch(modal, /Escape/, 'Esc 关闭被加回来了：Esc 还会同时触发下拉/输入框自身的 Esc 语义，误关代价高');
  assert.doesNotMatch(modal, /addEventListener\(\s*['"]keydown['"]/, '设置面板不应再挂全局 keydown 监听');
  assert.doesNotMatch(modal, /onMounted|onBeforeUnmount/, '关闭逻辑删除后不应残留无用的生命周期钩子');
});

test('关闭按钮自身必须真的关闭（emit close），且只此一处', () => {
  const triggers = modal.match(/emit\(\s*['"]close['"]\s*\)/g) ?? [];
  assert.equal(triggers.length, 1, `模板中 emit('close') 应恰好出现 1 次（关闭按钮），实际 ${triggers.length} 次`);
  assert.match(modal, /<button[^>]*@click="emit\('close'\)"/, '关闭按钮必须直接 emit close');
});

test('关闭按钮具备可访问名称（图标按钮不能只有一条 path）', () => {
  assert.match(modal, /:aria-label="t\('common\.close'\)"/, '关闭按钮缺少 aria-label，屏幕阅读器只能读出「按钮」');
});

test('父级仍然把 close 事件接成关闭动作', () => {
  assert.match(chatView, /@close="handleCloseSettings"/, 'ChatView 必须继续监听 SettingsModal 的 close');
  assert.match(workspace, /handleCloseSettings\s*=\s*\(\)\s*=>\s*\{\s*isSettingsOpen\.value\s*=\s*false;/, 'handleCloseSettings 必须把 isSettingsOpen 置 false');
});
