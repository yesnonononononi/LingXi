/**
 * 团队管理者下拉的界面门禁。
 *
 * <p>背景：设置页「团队协同」的管理者选择一度是裸 `<select>`，选项把描述塞进括号里、样式跟随系统、
 * 零动画，而同一个应用里已有统一的下拉组件 `SettingsSelect`（Teleport 面板 + 进出场过渡 + 键盘导航）。
 * 这里钉住三件事：</p>
 * <ol>
 *   <li>表单里不再出现原生 `<select>`，管理者控件是 `role=combobox` 的自绘触发器；</li>
 *   <li>面板有进出场过渡与箭头旋转（外观退化会立刻红）；</li>
 *   <li>回写的是后端原始 agentId（number），不是选项的字符串 value ——
 *       否则「管理者不是成员」校验会误报。</li>
 * </ol>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/team-commander-select');
const source = file => path.relative(output, path.join(root, file)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => {
  console.error('团队管理者下拉验证超时');
  app.exit(1);
}, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const agents = [
    { id: 11, name: '寇豆码', avatar: '🐢', description: '软件开发团队工程师。按系统设计与任务列表批量编写优雅、可读、可扩展的代码。', toolList: [{ id: 1 }] },
    { id: 12, name: '苏画意', avatar: '🎨', description: '软件开发团队美术工程师。视觉方案、素材生成与拆件合成、UI 视觉还原与资产规范。', toolList: [] },
    { id: 13, name: '路人甲', avatar: '', description: '', toolList: [] },
  ];
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup lang="ts">
import { nextTick } from 'vue';
import TeamsTab from '${source('src/views/settings/tabs/TeamsTab.vue')}';
import SettingsSelect from '${source('src/components/common/SettingsSelect.vue')}';
import { AgentAPI } from '${source('src/services/agent.ts')}';
import { TeamAPI } from '${source('src/services/team.ts')}';
import { UserConfigAPI } from '${source('src/services/userConfig.ts')}';
import { setPreference } from '${source('src/i18n/index.ts')}';
import { useTheme } from '${source('src/composables/useTheme.ts')}';
import '${source('src/style.css')}';

setPreference('zh-CN');
const theme = useTheme();
theme.setTheme('light');
const isDark = theme.isDark;

const agents = ${JSON.stringify(agents)};
window.agentFixture = agents;
AgentAPI.list = async () => ({ code: 1, data: { records: agents.map(item => ({ ...item })), total: agents.length } });
TeamAPI.list = async () => ({
  code: 1,
  data: {
    records: [{
      id: 7,
      name: '灵犀开发组',
      description: '端到端交付：设计、实现、验收同一条链路。',
      avatar: '🚀',
      commanderAgentId: 11,
      agents: agents.map(item => ({ ...item })),
    }],
    total: 1,
  },
});
window.teamWrites = [];
TeamAPI.update = async payload => { window.teamWrites.push(JSON.parse(JSON.stringify(payload))); return { code: 1 }; };
TeamAPI.add = async payload => { window.teamWrites.push(JSON.parse(JSON.stringify(payload))); return { code: 1 }; };
UserConfigAPI.current = async () => ({ code: 1, data: { teamSize: 10, renderTheme: 'LIGHT' } });
UserConfigAPI.updateCurrent = async () => ({ code: 1, data: null });

window.flush = async (ms = 60) => { await nextTick(); await new Promise(resolve => setTimeout(resolve, ms)); };
window.setDark = async value => { theme.setTheme(value ? 'dark' : 'light'); await window.flush(); };
window.probe = selector => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  return {
    tag: element.tagName,
    text: (element.textContent || '').trim(),
    className: element.className,
    opacity: Number(style.opacity),
    borderRadius: style.borderRadius,
    transform: style.transform,
    transitionProperty: style.transitionProperty,
    transitionDuration: style.transitionDuration,
    transformOrigin: style.transformOrigin,
  };
};
</script><template><main style="max-width:640px;margin:20px auto;padding:16px">
  <TeamsTab :is-dark="isDark" />
  <div style="margin-top:24px">
    <SettingsSelect
      id="standalone-select"
      data-testid="standalone-select"
      label="standalone"
      placeholder="请点击选择团队管理者"
      model-value=""
      :options="[{ value: 'a', label: 'A' }]"
    />
  </div>
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp} from 'vue';import {createPinia} from 'pinia';import App from './App.vue';
window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
createApp(App).use(createPinia()).mount('#app');`);
  await fs.writeFile(path.join(output, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  await build({
    configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    resolve: { dedupe: ['vue', 'pinia'] }, css: { postcss: { plugins: [tailwind()] } },
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true },
  });

  const window = new BrowserWindow({
    width: 760, height: 900, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const probe = selector => evaluate(`window.probe(${JSON.stringify(selector)})`);
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await evaluate('window.flush()');
  };

  await evaluate('window.flush()');

  // ---- 1. 占位文案：无匹配选项时显示 placeholder 而不是空白触发器 ----
  const placeholder = await probe('[data-testid=standalone-select]');
  assert.equal(placeholder.tag, 'BUTTON', '独立下拉也必须是自绘触发器');
  assert.equal(placeholder.text, '请点击选择团队管理者', '缺选项匹配时应显示占位文案');

  // ---- 2. 进入团队编辑表单：管理者控件不再是原生 select ----
  await click('[title="编辑团队"]');
  assert.equal(await evaluate('document.querySelectorAll("select").length'), 0,
    '表单里不应再出现原生 <select>');
  const trigger = await probe('[data-testid=team-commander-select]');
  assert.ok(trigger, '管理者下拉触发器缺失');
  assert.equal(trigger.tag, 'BUTTON');
  assert.match(trigger.text, /寇豆码/, '触发器应显示当前管理者');
  assert.match(trigger.borderRadius, /12px/, '触发器应沿用统一圆角');
  assert.match(trigger.transitionDuration, /\d/, '触发器应有过渡（不是系统裸控件）');
  assert.match(trigger.transitionProperty, /border-color/, '触发器应过渡边框颜色');
  assert.match(trigger.transform, /none/i, '收起时箭头不应旋转');
  assert.equal(await evaluate('document.querySelector("[role=listbox]")'), null, '初始不应渲染面板');

  // ---- 3. 展开：面板 Teleport 到 body，带进出场过渡类 ----
  const opened = await evaluate(`(async () => {
    document.querySelector('[data-testid=team-commander-select]').click();
    await window.flush(0);
    const panel = document.querySelector('[role=listbox]');
    const style = panel ? getComputedStyle(panel) : null;
    const startOpacity = style ? Number(style.opacity) : null;
    // 再采样一次：真过渡的中途透明度必须仍在 0..1 之间，否则说明过渡被删成「瞬间完成」
    await new Promise(resolve => setTimeout(resolve, 50));
    const midOpacity = panel ? Number(getComputedStyle(panel).opacity) : null;
    return {
      exists: !!panel,
      parentIsBody: panel ? panel.parentElement === document.body : false,
      className: panel ? panel.className : '',
      opacity: startOpacity,
      midOpacity,
      transform: style ? style.transform : null,
      transformOrigin: style ? style.transformOrigin : null,
      role: panel ? panel.getAttribute('role') : null,
      transitionDuration: style ? style.transitionDuration : null,
    };
  })()`);
  assert.equal(opened.exists, true, '点击后应渲染选项面板');
  assert.equal(opened.parentIsBody, true, '面板必须 Teleport 到 body，避免被设置弹窗裁剪');
  assert.equal(opened.role, 'listbox');
  assert.match(opened.className, /settings-select-enter-active/, '展开时必须有进场过渡类');
  assert.ok(opened.opacity !== null && opened.opacity < 1, `进场应从透明开始，实际 ${opened.opacity}`);
  assert.ok(opened.midOpacity !== null && opened.midOpacity > opened.opacity && opened.midOpacity < 0.99,
    `50ms 时面板应处在过渡中途（0..1 之间），实际 ${opened.midOpacity}：过渡被删成瞬间完成会落到 1`);
  assert.match(opened.transitionDuration || '', /0\.1[0-9]*s|0\.2[0-9]*s/,
    `面板自身的过渡时长必须非零，实际 ${opened.transitionDuration}`);
  const rotated = await probe('[data-testid=team-commander-select] svg');
  assert.match(rotated.transform, /matrix/, '展开后箭头应旋转 180°');

  await evaluate('window.flush(260)');
  const settled = await probe('[role=listbox]');
  assert.ok(settled.opacity > 0.99, '过渡结束后面板应完全不透明');
  assert.doesNotMatch(settled.className, /settings-select-enter-active/, '过渡结束后应移除过渡类');

  // ---- 4. 选项渲染：描述独立成行（不再塞进括号里），当前管理者打勾 ----
  const options = await evaluate(`Array.from(document.querySelectorAll('[role=option]')).map(node => ({
    value: node.getAttribute('data-value'),
    text: (node.textContent || '').trim(),
    selected: node.getAttribute('aria-selected'),
  }))`);
  assert.equal(options.length, 3, '选项数量应等于已选成员数');
  assert.deepEqual(options.map(item => item.value), ['11', '12', '13']);
  assert.match(options[0].text, /寇豆码/);
  assert.match(options[0].text, /软件开发团队工程师/, '选项必须显示成员描述（作为独立行）');
  assert.doesNotMatch(options[0].text, /[（(]/, '描述不应再被括号塞进同一行');
  assert.equal(options[0].selected, 'true');
  assert.equal(options[1].selected, 'false');
  const descLine = await evaluate(`document.querySelector('[role=option][data-value="11"]')?.querySelectorAll('span').length > 1`);
  assert.equal(descLine, true, '描述应是独立的一行（label + desc 两个节点）');

  // ---- 5. 键盘：Esc 关闭、ArrowDown 打开并移动、Enter 选中 ----
  await evaluate(`document.querySelector('[data-testid=team-commander-select]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await evaluate('window.flush(220)');
  assert.equal(await evaluate('document.querySelector("[data-testid=team-commander-select]").getAttribute("aria-expanded")'), 'false', 'Esc 后 aria-expanded 应为 false');
  assert.equal(await evaluate('document.querySelector("[role=listbox]")'), null, 'Esc 应关闭面板（含离场过渡结束）');

  await evaluate(`document.querySelector('[data-testid=team-commander-select]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await evaluate('window.flush()');
  assert.ok(await evaluate('!!document.querySelector("[role=listbox]")'), 'ArrowDown 应展开面板');
  await evaluate(`(() => { const el = document.querySelector('[data-testid=team-commander-select]'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
  await evaluate('window.flush()');
  await evaluate(`document.querySelector('[data-testid=team-commander-select]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await evaluate('window.flush(220)');
  assert.equal(await evaluate('document.querySelector("[role=listbox]")'), null, 'Enter 选中后面板应关闭（含离场过渡结束）');
  assert.match((await probe('[data-testid=team-commander-select]')).text, /苏画意/, 'Enter 应选中第二项');

  // ---- 6. 鼠标选择 + 保存：回写后端原始 id（number），不是字符串 value ----
  await click('[data-testid=team-commander-select]');
  await click('[role=option][data-value="13"]');
  assert.match((await probe('[data-testid=team-commander-select]')).text, /路人甲/, '点击选项应更新触发器');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === '保存').click()`);
  await evaluate('window.flush(120)');
  const writes = await evaluate('window.teamWrites');
  assert.equal(writes.length, 1, '保存应发出一次更新请求');
  assert.equal(writes[0].commanderAgentId, 13, '回写必须是后端原始 id（number），不能是字符串 value');
  assert.equal(typeof writes[0].commanderAgentId, 'number');
  assert.equal(await evaluate('document.querySelectorAll("select").length'), 0,
    '保存后表单仍不应出现原生 select');

  // ---- 7. 浅深两套主题截图 ----
  await click('[title="编辑团队"]');
  for (const dark of [false, true]) {
    await evaluate(`window.setDark(${dark})`);
    await click('[data-testid=team-commander-select]');
    await evaluate('window.flush(320)');
    const themeBranch = await evaluate(`(() => {
      const input = document.querySelector('input[placeholder]');
      const style = getComputedStyle(input);
      return { background: style.backgroundColor, color: style.color };
    })()`);
    const toRgb = value => value.match(/\d+/g).slice(0, 3).map(Number);
    const luminance = value => { const [r, g, b] = toRgb(value); return (r + g + b) / 3; };
    assert.ok(dark ? luminance(themeBranch.background) < 80 : luminance(themeBranch.background) > 200,
      `${dark ? '深色' : '浅色'}主题下输入框底色应按主题分支渲染，实际 ${themeBranch.background}`);
    assert.ok(dark ? luminance(themeBranch.color) > 180 : luminance(themeBranch.color) < 90,
      `${dark ? '深色' : '浅色'}主题下输入框文字应随主题反色，实际 ${themeBranch.color}`);
    await fs.writeFile(path.join(output, `fixture-${dark ? 'dark' : 'light'}.png`),
      (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('[data-testid=team-commander-select]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate('window.flush()');
  }

  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  clearTimeout(deadline);
  console.log('PASS 团队管理者下拉：自绘触发器、Teleport 面板、进出场过渡、键盘导航、原始 id 回写、浅深主题');
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
