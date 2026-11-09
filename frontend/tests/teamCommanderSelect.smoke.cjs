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
    { id: 11, name: '寇豆码', avatar: '🐢', description: '软件开发团队工程师。按系统设计与任务列表批量编写优雅、可读、可扩展的代码。', toolList: ['executeCommand'] },
    { id: 12, name: '苏画意', avatar: '🎨', description: '软件开发团队美术工程师。视觉方案、素材生成与拆件合成、UI 视觉还原与资产规范。', toolList: [] },
    { id: 13, name: '路人甲', avatar: '', description: '', toolList: [] },
  ];
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup lang="ts">
import { nextTick, ref } from 'vue';
import TeamsTab from '${source('src/views/settings/tabs/TeamsTab.vue')}';
import TeamModal from '${source('src/components/chat/TeamModal.vue')}';
import SettingsSelect from '${source('src/components/common/SettingsSelect.vue')}';
import { AgentAPI } from '${source('src/services/agent.ts')}';
import { TeamAPI } from '${source('src/services/team.ts')}';
import { ToolAPI } from '${source('src/services/tool.ts')}';
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
// 记录调用次数：弹窗打开时应只拉一次 Agent 列表，且必须真的来自这份 mock（而不是真实 http）
window.agentListCalls = 0;
AgentAPI.list = async () => {
  window.agentListCalls += 1;
  return { code: 1, data: { records: agents.map(item => ({ ...item })), total: agents.length } };
};
ToolAPI.list = async () => ({ code: 1, data: [{ id: 1, name: 'executeCommand', displayName: '执行命令' }] });
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
AgentAPI.findById = async id => ({ code: 1, data: agents.find(item => String(item.id) === String(id)) });
window.teamModels = [
  { id: 21, name: '主力模型', modelName: 'main-model' },
  { id: 22, name: '备用模型', modelName: 'backup-model' },
];
UserConfigAPI.current = async () => ({ code: 1, data: { teamSize: 10, renderTheme: 'LIGHT' } });
UserConfigAPI.updateCurrent = async () => ({ code: 1, data: null });

window.flush = async (ms = 60) => { await nextTick(); await new Promise(resolve => setTimeout(resolve, ms)); };
window.setDark = async value => { theme.setTheme(value ? 'dark' : 'light'); await window.flush(); };
const teamModels = [
  { id: 21, name: '主力模型', modelName: 'main-model' },
  { id: 22, name: '备用模型', modelName: 'backup-model' },
];
const teamModalOpen = ref(false);
window.showTeamModal = async () => { teamModalOpen.value = true; await window.flush(180); };
window.probeAgentApi = async () => {
  const res = await AgentAPI.list(1, 100);
  return { code: res && res.code, count: res && res.data && res.data.records ? res.data.records.length : -1 };
};
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
  <TeamModal v-if="teamModalOpen" :is-open="true" :models="teamModels" />
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
    const samples = [];
    for (let step = 0; step < 6; step += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const node = document.querySelector('[role=listbox]');
      samples.push(node ? Number(getComputedStyle(node).opacity) : null);
    }
    const midOpacity = samples.length ? Math.min(...samples.map(value => value ?? 0)) : null;
    return {
      exists: !!panel,
      parentIsBody: panel ? panel.parentElement === document.body : false,
      className: panel ? panel.className : '',
      opacity: startOpacity,
      samples,
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
  assert.ok(opened.samples.some(value => value !== null && value > 0.02 && value < 0.98),
    `过渡中途必须出现过 0..1 之间的透明度（瞬间完成或被卡住都会红），实际采样 ${JSON.stringify(opened.samples)}`);
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

  // ---- 8. 团队弹窗：管理者下拉与 Agent 模型下拉都走同一壳，不再有自绘/原生实现 ----
  // 设置页自己也有一个 data-testid=team-commander-select 的管理者下拉，两个同时挂载时必须
  // 限定在弹窗作用域内定位，否则断言会张冠李戴（查到的其实是设置页那一份）。
  await evaluate('window.showTeamModal()');
  await evaluate('window.flush(240)');
  assert.equal(await evaluate('document.querySelectorAll("[role=dialog]").length'), 1,
    '团队弹窗打开后应有且仅有一个对话框');
  assert.equal(await evaluate('document.querySelectorAll("select").length'), 0,
    '团队弹窗内不应再出现原生 <select>');
  for (const agentId of [11, 12, 13]) {
    assert.equal(await evaluate(`!!document.querySelector('[role=dialog] [data-testid=team-agent-option-${agentId}]')`), true,
      `团队弹窗成员项 ${agentId} 缺失`);
    await click(`[role=dialog] [data-testid=team-agent-option-${agentId}]`);
  }
  assert.equal(await evaluate('document.querySelectorAll("[role=dialog] [data-testid=team-commander-select]").length'), 1,
    '选中成员后应有且仅有一个管理者下拉');
  const modalTrigger = await probe('[role=dialog] [data-testid=team-commander-select]');
  assert.ok(modalTrigger, '团队弹窗的管理者下拉缺失');
  assert.equal(modalTrigger.tag, 'BUTTON');
  assert.match(modalTrigger.text, /寇豆码/, '团队弹窗触发器应显示当前管理者');
  assert.equal(await evaluate('document.querySelector("[role=dialog] [data-testid=team-commander-select]").getAttribute("role")'), 'combobox');

  await click('[role=dialog] [data-testid=team-commander-select]');
  await evaluate('window.flush(320)');
  assert.equal(await evaluate('document.querySelector("#team-modal-commander-select-menu").parentElement === document.body'), true,
    '团队弹窗的面板也必须 Teleport 到 body（否则会被弹窗裁剪）');
  const modalOptions = await evaluate(`Array.from(document.querySelectorAll('#team-modal-commander-select-menu [role=option]')).map(node => ({
    value: node.getAttribute('data-value'),
    text: (node.textContent || '').trim(),
  }))`);
  assert.deepEqual(modalOptions.map(item => item.value), ['11', '12', '13'], '管理者选项应等于已选成员');
  assert.match(modalOptions[0].text, /当前管理者/, '选中项应保留「当前管理者」徽标');
  assert.match(modalOptions[0].text, /软件开发团队工程师/, '选项应显示成员描述');
  await evaluate(`document.querySelector('#team-modal-commander-select-menu [role=option][data-value="12"]').click()`);
  await evaluate('window.flush(240)');
  assert.match((await probe('[role=dialog] [data-testid=team-commander-select]')).text, /苏画意/, '点击选项应切换管理者');

  // Agent 编辑表单里的模型下拉同样是壳（按钮 + combobox），不是原生 select
  await click('[role=dialog] [data-testid=team-agent-option-11] button');
  await evaluate('window.flush(200)');
  const modelTrigger = await probe('[role=dialog] [data-testid=team-agent-model]');
  assert.ok(modelTrigger, 'Agent 表单的模型下拉缺失');
  assert.equal(modelTrigger.tag, 'BUTTON');
  assert.equal(await evaluate('document.querySelector("[role=dialog] [data-testid=team-agent-model]").getAttribute("role")'), 'combobox');
  assert.equal(await evaluate('document.querySelectorAll("select").length'), 0,
    '打开 Agent 表单后仍不应出现原生 select');
  await click('[role=dialog] [data-testid=team-agent-model]');
  await evaluate('window.flush(240)');
  const modelOptions = await evaluate(`Array.from(document.querySelectorAll('#team-agent-model-menu [role=option]')).map(node => node.getAttribute('data-value'))`);
  assert.deepEqual(modelOptions, ['21', '22'], '模型下拉应渲染传入的模型列表');
  await evaluate(`document.querySelector('#team-agent-model-menu [role=option][data-value="22"]').click()`);
  await evaluate('window.flush(220)');
  assert.match((await probe('[role=dialog] [data-testid=team-agent-model]')).text, /备用模型/, '模型下拉应能选中');

  // 保存团队：管理者必须回写成后端原始 id（number）
  await evaluate(`(async () => {
    const input = document.querySelector('[data-testid=team-name-input]');
    input.value = '门禁团队';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate('window.flush(120)');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === '创建团队').click()`);
  await evaluate('window.flush(240)');
  const modalWrites = await evaluate('window.teamWrites');
  const modalPayload = modalWrites[modalWrites.length - 1];
  assert.equal(modalPayload.commanderAgentId, 12, '团队弹窗保存的 commanderAgentId 必须是原始 number id');
  assert.equal(typeof modalPayload.commanderAgentId, 'number');

  // Agent 列表确实被拉过一次并渲染：防止「静默空列表」（早期 TDZ 报错被吞时就是这种表现）
  assert.equal(await evaluate('window.agentListCalls >= 2'), true,
    '团队弹窗打开时应真正请求 Agent 列表（设置页一次 + 弹窗一次），不能静默空列表');
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  clearTimeout(deadline);
  console.log('PASS 团队管理者下拉：自绘触发器、Teleport 面板、进出场过渡、键盘导航、原始 id 回写、浅深主题');
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
