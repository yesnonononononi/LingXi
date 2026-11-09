/**
 * LxSelect 外壳门禁。
 *
 * <p>LxSelect 是「下拉选择」的唯一实现，SettingsSelect / DropUpSelect 只是它的预设薄壳。
 * 这里把**行为契约**钉死，任何一处退化都会立刻红：</p>
 * <ol>
 *   <li>a11y：触发器 button[role=combobox][aria-haspopup=listbox]，面板 role=listbox 且 id 为
 *       `${id}-menu`，aria-expanded / aria-activedescendant 跟随开合与高亮；</li>
 *   <li>键盘：ArrowDown 打开并移动、Home/End 首尾、Enter 选中、Escape 关闭、Tab 关闭；</li>
 *   <li>值：字符串投影比较（后端主键是字符串、本地选项是数字时不能判不等）；</li>
 *   <li>插槽：#trigger / #option 可接管内容；</li>
 *   <li>搜索 / 分组折叠 / 空态；</li>
 *   <li>面板宽度策略：settings 与触发器同宽，popup 内容自适应且有上限。</li>
 * </ol>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/lx-select');
const source = file => path.relative(output, path.join(root, file)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => {
  console.error('LxSelect 门禁超时');
  app.exit(1);
}, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup lang="ts">
import { ref } from 'vue';
import LxSelect from '${source('src/components/common/LxSelect.vue')}';
import { setPreference } from '${source('src/i18n/index.ts')}';
import { useTheme } from '${source('src/composables/useTheme.ts')}';
import '${source('src/style.css')}';

setPreference('zh-CN');
useTheme().setTheme('light');

window.flush = async (ms = 60) => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const picked = ref('b');
const numeric = ref(5);
const popupValue = ref('');
const events = [];
const basicOptions = [
  { value: 'a', label: 'Alpha', description: '第一个选项' },
  { value: 'b', label: 'Beta', description: '第二个选项' },
  { value: 'c', label: 'Cherry', disabled: true },
];
const numericOptions = [
  { value: 5, label: '数字五' },
  { value: '6', label: '字符串六' },
];
// 跨类型：modelValue 是字符串 '5'，选项值是数字 5 —— 严格 === 会判不等并回落成占位文案
const crossType = ref('5');
const setCrossType = value => { crossType.value = value; events.push(['cross', value]); };
const groupedOptions = [
  { value: 'm1', label: 'gpt-4o', group: 'OpenAI' },
  { value: 'm2', label: 'claude-4', group: 'Anthropic' },
  { value: 'm3', label: 'o3-mini', group: 'OpenAI' },
];
const setPicked = value => { picked.value = value; events.push(['basic', value]); };
const setNumeric = value => { numeric.value = value; events.push(['numeric', value]); };
const setPopup = value => { popupValue.value = value; events.push(['popup', value]); };
window.events = events;
</script><template><main style="max-width:520px;margin:24px auto;padding:16px;display:flex;flex-direction:column;gap:20px">
  <!-- 设置页预设：同宽面板 + 默认触发器 + 默认选项（label + desc） -->
  <LxSelect
    id="basic"
    data-testid="basic"
    label="基础下拉"
    :model-value="picked"
    :options="basicOptions"
    @update:model-value="setPicked"
  />

  <!-- 字符串投影比较：modelValue 是数字 5，选项值也是数字 5 -->
  <LxSelect
    id="numeric"
    data-testid="numeric"
    label="数字下拉"
    :model-value="numeric"
    :options="numericOptions"
    @update:model-value="setNumeric"
  />

  <!-- 跨类型比较：modelValue 是字符串 '5'，选项值是数字 5 -->
  <LxSelect
    id="cross-type"
    data-testid="cross-type"
    label="跨类型下拉"
    :model-value="crossType"
    :options="numericOptions"
    @update:model-value="setCrossType"
  />

  <!-- 上拉预设：可搜索 + 分组 + 自定义 trigger/option 插槽 -->
  <LxSelect
    id="popup"
    data-testid="popup"
    label="模型下拉"
    variant="popup"
    searchable
    search-placeholder="搜索模型"
    menu-title="可用模型"
    empty-text="没有匹配的模型"
    :model-value="popupValue"
    :options="groupedOptions"
    @update:model-value="setPopup"
  >
    <template #trigger="{ isOpen: isPopupOpen, label: triggerLabel }">
      <span data-testid="popup-trigger-content">自定义:{{ triggerLabel }}:{{ isPopupOpen }}</span>
    </template>
    <template #option="{ option: slotOption, selected: slotSelected }">
      <span data-testid="popup-option-content">注入:{{ slotOption.value }}:{{ slotSelected }}</span>
    </template>
  </LxSelect>

  <LxSelect
    id="disabled"
    data-testid="disabled"
    label="禁用下拉"
    disabled
    model-value="a"
    :options="basicOptions"
  />
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
    width: 640, height: 720, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await evaluate('window.flush()');
  };
  const key = async (selector, name) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`);
    await evaluate('window.flush()');
  };

  await evaluate('window.flush(120)');

  // ---- 1. 关闭态：combobox 契约、aria-expanded=false、无面板 ----
  const closed = await evaluate(`(() => {
    const trigger = document.querySelector('[data-testid=basic]');
    return {
      tag: trigger.tagName,
      role: trigger.getAttribute('role'),
      haspopup: trigger.getAttribute('aria-haspopup'),
      expanded: trigger.getAttribute('aria-expanded'),
      controls: trigger.getAttribute('aria-controls'),
      activedescendant: trigger.getAttribute('aria-activedescendant'),
      text: (trigger.textContent || '').trim(),
      panel: document.querySelectorAll('[role=listbox]').length,
    };
  })()`);
  assert.equal(closed.tag, 'BUTTON', '触发器必须是 button');
  assert.equal(closed.role, 'combobox');
  assert.equal(closed.haspopup, 'listbox');
  assert.equal(closed.expanded, 'false');
  assert.equal(closed.controls, 'basic-menu', 'aria-controls 必须指向 `${id}-menu`');
  assert.equal(closed.activedescendant, null, '收起时不应有 aria-activedescendant');
  assert.match(closed.text, /Beta/, '触发器应显示当前值对应的文案');
  assert.equal(closed.panel, 0, '初始不应渲染面板');

  // ---- 2. 键盘：ArrowDown 打开并高亮当前值，ArrowDown 移动，Home/End 首尾 ----
  await key('[data-testid=basic]', 'ArrowDown');
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('[data-testid=basic]');
    const panel = document.querySelector('#basic-menu');
    return {
      expanded: trigger.getAttribute('aria-expanded'),
      activedescendant: trigger.getAttribute('aria-activedescendant'),
      onBody: panel ? panel.parentElement === document.body : false,
      className: panel ? panel.className : '',
      childOfRoot: panel ? document.querySelector('[data-testid=basic]').parentElement.parentElement.contains(panel) : false,
      optionCount: document.querySelectorAll('#basic-menu [role=option]').length,
      optionClasses: Array.from(document.querySelectorAll('#basic-menu [role=option]')).map(node => node.className),
      selectedAttr: document.querySelector('#basic-menu [role=option][data-value="b"]').getAttribute('aria-selected'),
    };
  })()`);
  assert.equal(opened.expanded, 'true');
  assert.equal(opened.onBody, true, '面板必须 Teleport 到 body');
  assert.equal(opened.childOfRoot, false);
  assert.match(opened.className, /settings-select-menu/, 'settings 预设必须保留 settings-select-menu 类名');
  assert.equal(opened.activedescendant, 'basic-option-1', '展开始终应高亮当前选中项');
  assert.equal(opened.optionCount, 3);
  assert.ok(opened.optionClasses.every(name => name.includes('settings-select-option')),
    'settings 预设的选项必须带 settings-select-option 类名');
  assert.equal(opened.selectedAttr, 'true');

  // 面板宽度必须在进场过渡结束后量（过渡中的 scale 会让 rect 偏小）
  await evaluate('window.flush(260)');
  const sized = await evaluate(`(() => {
    const trigger = document.querySelector('[data-testid=basic]');
    const panel = document.querySelector('#basic-menu');
    return {
      triggerWidth: Math.round(trigger.getBoundingClientRect().width),
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      inlineWidth: panel.style.width,
      left: Math.round(panel.getBoundingClientRect().left),
      triggerLeft: Math.round(trigger.getBoundingClientRect().left),
      className: panel.className,
    };
  })()`);
  assert.equal(sized.panelWidth, sized.triggerWidth,
    `settings 预设面板必须与触发器同宽（面板 ${sized.panelWidth} vs 触发器 ${sized.triggerWidth}）`);
  assert.match(String(sized.inlineWidth), /^\d+(\.\d+)?px$/, 'settings 预设必须显式写死面板宽度（content 策略不写 width）');
  assert.equal(Math.round(parseFloat(sized.inlineWidth)), sized.triggerWidth,
    'settings 预设写死的宽度必须等于触发器宽度');
  assert.equal(sized.left, sized.triggerLeft, 'settings 预设面板必须与触发器左对齐');
  assert.doesNotMatch(sized.className, /enter-active/, '过渡结束后应移除过渡类');

  await key('[data-testid=basic]', 'ArrowDown');
  assert.equal(await evaluate('document.querySelector("[data-testid=basic]").getAttribute("aria-activedescendant")'), 'basic-option-2');
  await key('[data-testid=basic]', 'Home');
  assert.equal(await evaluate('document.querySelector("[data-testid=basic]").getAttribute("aria-activedescendant")'), 'basic-option-0');
  await key('[data-testid=basic]', 'End');
  assert.equal(await evaluate('document.querySelector("[data-testid=basic]").getAttribute("aria-activedescendant")'), 'basic-option-2');

  // ---- 3. Enter 选中：写回值、关闭面板、触发 change ----
  await evaluate(`document.querySelector('[data-testid=basic]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
  await evaluate('window.flush()');
  await key('[data-testid=basic]', 'Enter');
  await evaluate('window.flush(260)');
  const afterEnter = await evaluate(`({
    expanded: document.querySelector('[data-testid=basic]').getAttribute('aria-expanded'),
    text: (document.querySelector('[data-testid=basic]').textContent || '').trim(),
    events: window.events.filter(item => item[0] === 'basic'),
    panels: document.querySelectorAll('[role=listbox]').length,
  })`);
  assert.equal(afterEnter.expanded, 'false', 'Enter 选中后应收起');
  assert.match(afterEnter.text, /Alpha/, '选中项应回写到触发器');
  assert.deepEqual(afterEnter.events, [['basic', 'a']], '选中必须 emit 一次 update:modelValue');
  assert.equal(afterEnter.panels, 0, '收起后面板必须从 DOM 移除');

  // ---- 4. Escape 关闭且不写值；Tab 关闭 ----
  await click('[data-testid=basic]');
  await key('[data-testid=basic]', 'Escape');
  assert.equal(await evaluate('document.querySelector("[data-testid=basic]").getAttribute("aria-expanded")'), 'false');
  assert.deepEqual(await evaluate('window.events.filter(item => item[0] === "basic")'), [['basic', 'a']],
    'Escape 不能写回值');

  await click('[data-testid=basic]');
  await key('[data-testid=basic]', 'Tab');
  assert.equal(await evaluate('document.querySelector("[data-testid=basic]").getAttribute("aria-expanded")'), 'false',
    'Tab 应关闭面板（不能把面板留在身后）');

  // ---- 5. 禁用选项不可点：点 Cherry 只关面板、不写值 ----
  await click('[data-testid=basic]');
  await evaluate(`document.querySelector('#basic-menu [role=option][data-value="c"]').click()`);
  await evaluate('window.flush()');
  assert.deepEqual(await evaluate('window.events.filter(item => item[0] === "basic")'), [['basic', 'a']],
    '禁用项被点击时不能写回值');

  // ---- 6. 值按字符串比较：数字选项 + 数字 modelValue 也要命中 ----
  assert.match(await evaluate('(document.querySelector("[data-testid=numeric]").textContent || "")'), /数字五/,
    '数字值必须能匹配到选项（严格 === 会把 number/string 判不等）');
  assert.match(await evaluate('(document.querySelector("[data-testid=cross-type]").textContent || "")'), /数字五/,
    '字符串 modelValue 应命中数字 value 的选项（后端主键常是字符串）');
  await click('[data-testid=numeric]');
  await evaluate(`document.querySelector('#numeric-menu [role=option][data-value="6"]').click()`);
  await evaluate('window.flush()');
  assert.match(await evaluate('(document.querySelector("[data-testid=numeric]").textContent || "")'), /字符串六/);
  assert.deepEqual(await evaluate('window.events.filter(item => item[0] === "numeric")'), [['numeric', '6']]);

  // ---- 7. 外部点击关闭 ----
  await evaluate('window.flush(260)');
  await click('[data-testid=basic]');
  assert.equal(await evaluate('document.querySelectorAll("[role=listbox]").length'), 1, '点击后应打开面板');
  await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await evaluate('window.flush(260)');
  assert.equal(await evaluate('document.querySelectorAll("[role=listbox]").length'), 0, '点击面板外应关闭');

  // ---- 8. 禁用整体：点了不打开 ----
  await click('[data-testid=disabled]');
  assert.equal(await evaluate('document.querySelectorAll("[role=listbox]").length'), 0, '禁用的下拉不应打开');

  // ---- 9. popup 预设：插槽接管、分组、搜索、空态、面板宽度上限 ----
  const popupTrigger = await evaluate(`(() => {
    const node = document.querySelector('[data-testid=popup]');
    return {
      text: (node.textContent || '').trim(),
      placeholderText: (node.querySelector('[data-testid=popup-trigger-content]') || {}).textContent || '',
    };
  })()`);
  assert.match(popupTrigger.text, /自定义:/, '#trigger 插槽必须能接管触发器内容');
  assert.match(popupTrigger.placeholderText, /自定义::false/, '未选中时应把 placeholder（空）与开合状态交给插槽');

  await click('[data-testid=popup]');
  const popupOpened = await evaluate(`(() => {
    const panel = document.querySelector('#popup-menu');
    const style = panel.style;
    return {
      maxWidth: style.maxWidth,
      minWidth: style.minWidth,
      groups: Array.from(panel.querySelectorAll('button[aria-expanded]')).map(node => (node.textContent || '').trim()),
      options: Array.from(panel.querySelectorAll('[role=option]')).map(node => ({
        value: node.getAttribute('data-value'),
        text: (node.textContent || '').trim(),
      })),
      title: (panel.textContent || '').includes('可用模型'),
      hasSearch: !!panel.querySelector('input[type=text]'),
    };
  })()`);
  assert.equal(popupOpened.hasSearch, true, 'searchable 必须渲染搜索框');
  assert.equal(popupOpened.title, true, 'menuTitle 必须渲染');
  assert.equal(popupOpened.groups.length, 2, '应按 group 渲染两个分组标题');
  assert.match(popupOpened.groups[0], /OpenAI/);
  assert.equal(popupOpened.options.length, 0, '分组默认折叠：打开时不应直接铺满选项');
  assert.equal(popupOpened.maxWidth, '224px', 'popup 预设面板必须有宽度上限');
  assert.equal(popupOpened.minWidth !== 'auto' && /px$/.test(popupOpened.minWidth || ''), true,
    'popup 预设面板必须给出最小宽度');

  // 展开分组：点 OpenAI 标题后该组选项按原始顺序出现，再次点击折叠
  await evaluate(`document.querySelectorAll('#popup-menu button[aria-expanded]')[0].click()`);
  await evaluate('window.flush(120)');
  const expandedGroup = await evaluate(`({
    values: Array.from(document.querySelectorAll('#popup-menu [role=option]')).map(node => node.getAttribute('data-value')),
    texts: Array.from(document.querySelectorAll('#popup-menu [role=option]')).map(node => (node.textContent || '').trim()),
  })`);
  assert.deepEqual(expandedGroup.values, ['m1', 'm3'], '展开的组必须按原始顺序渲染选项');
  assert.match(expandedGroup.texts[0], /注入:m1:false/, '#option 插槽必须能接管选项内容');
  await evaluate(`document.querySelectorAll('#popup-menu button[aria-expanded]')[0].click()`);
  await evaluate('window.flush(120)');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#popup-menu [role=option]')).map(node => node.getAttribute('data-value'))`),
    [], '折叠的组不应渲染其选项');

  // 搜索：过滤后仍保留分组与插槽；无匹配走空态
  await evaluate(`(() => {
    const input = document.querySelector('#popup-menu input[type=text]');
    input.value = 'cla';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate('window.flush(80)');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#popup-menu [role=option]')).map(node => node.getAttribute('data-value'))`),
    ['m2'], '搜索应过滤掉不匹配的选项（描述也参与匹配）');
  await evaluate(`(() => {
    const input = document.querySelector('#popup-menu input[type=text]');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate('window.flush(80)');
  assert.equal(await evaluate(`document.querySelector('#popup-menu [role=option]')`), null, '无匹配时不应有选项');
  assert.match(await evaluate('(document.querySelector("#popup-menu").textContent || "")'), /没有匹配的模型/,
    '无匹配时应显示 emptyText');

  // Enter 在搜索框里选中首个匹配项
  await evaluate(`(() => {
    const input = document.querySelector('#popup-menu input[type=text]');
    input.value = 'claude';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate('window.flush(80)');
  await evaluate(`document.querySelector('#popup-menu input[type=text]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await evaluate('window.flush(260)');
  assert.deepEqual(await evaluate('window.events.filter(item => item[0] === "popup")'), [['popup', 'm2']],
    '搜索框里按 Enter 应选中首个匹配项');
  assert.equal(await evaluate('document.querySelectorAll("[role=listbox]").length'), 0, '选中后应收起');

  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  clearTimeout(deadline);
  console.log('PASS LxSelect：a11y 契约、键盘导航、禁用项、字符串投影比较、插槽、分组折叠、搜索与空态、面板宽度策略');
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
