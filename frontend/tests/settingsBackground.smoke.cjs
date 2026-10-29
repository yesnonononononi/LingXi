const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { registerBackgroundImages } = require('../electron/background-images.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/settings-background');
const source = file => path.relative(output, path.join(root, file)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const checkpoint = value => fs.appendFile(path.join(output, 'progress.log'), `${value}\n`);
const deadline = setTimeout(() => {
  fs.writeFile(path.join(output, 'error.log'), '背景设置验证超时').finally(() => app.exit(1));
}, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'progress.log'), '');
  await fs.rm(path.join(output, 'error.log'), { force: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  await checkpoint('准备真实背景 IPC 与设置页面');
  const chatView = await fs.readFile(path.join(root, 'src/views/chat/ChatView.vue'), 'utf8');
  // 使用生产宿主的实际注册语句，避免测试另写一套切换逻辑而假绿。
  const binding = chatView.match(/const \{ hasBackground: hasBackgroundImage \} = useBackgroundPreference\(\);[\s\S]*?provide\(BACKGROUND_SLOTS_KEY, backgroundSlots\);/)?.[0];
  assert.ok(binding, '未找到主页的真实背景注册入口');
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup lang="ts">
import { ref, nextTick, provide, shallowReactive, watch, type Component } from 'vue';
import SettingsModal from '${source('src/views/settings/SettingsModal.vue')}';
import ChatBackground from '${source('src/components/chat/ChatBackground.vue')}';
import TokenBackground from '${source('src/components/background/TokenBackground.vue')}';
import ImageBackground from '${source('src/components/background/ImageBackground.vue')}';
import { BACKGROUND_SLOTS_KEY } from '${source('src/types/backgroundSlots.ts')}';
import { useBackgroundPreference, BACKGROUND_STORAGE_KEY } from '${source('src/composables/useBackgroundPreference.ts')}';
import { UserConfigAPI } from '${source('src/services/userConfig.ts')}';
import { useTheme } from '${source('src/composables/useTheme.ts')}';
import { setPreference } from '${source('src/i18n/index.ts')}';
import '${source('src/style.css')}';
setPreference('zh-CN');
const theme = useTheme(); theme.setTheme('dark');
UserConfigAPI.current = async () => ({code:1,data:{renderTheme:'DARK'}});
const show = ref(true);
${binding}
const background = useBackgroundPreference();
await background.init();
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 420)); };
window.setModal = async (value: boolean) => { show.value = value; await window.flush(); };
window.setDark = async (dark: boolean) => { theme.setTheme(dark ? 'dark' : 'light'); await window.flush(); };
window.backgroundProbe = () => ({
  preference: JSON.parse(JSON.stringify(background.preference.value)),
  stored: localStorage.getItem(BACKGROUND_STORAGE_KEY),
  image: getComputedStyle(document.querySelector('.lx-chat-background')!).backgroundImage,
  fit: getComputedStyle(document.querySelector('.lx-chat-background')!).backgroundSize,
  scrim: document.querySelector('.lx-image-background__scrim')
    ? getComputedStyle(document.querySelector('.lx-image-background__scrim')!).opacity : null,
  glow: !!document.querySelector('.lx-chat-background__glow'),
});
</script><template><main class="relative w-screen h-screen overflow-hidden"><ChatBackground />
<SettingsModal v-if="show" :teleport="false" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,Suspense,h} from 'vue';import {createPinia} from 'pinia';import App from './App.vue';
window.runtimeErrors=[];window.addEventListener('error',e=>window.runtimeErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.runtimeErrors.push(String(e.reason)));
createApp({render:()=>h(Suspense,null,{default:()=>h(App)})}).use(createPinia()).mount('#app');`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{platform:process.platform,background:{pick:()=>ipcRenderer.invoke('background:pick'),load:name=>ipcRenderer.invoke('background:load',name),clear:()=>ipcRenderer.invoke('background:clear')}});`);
  const fixtures = [];
  for (const [name, pixel] of [['first', [45, 95, 210, 255]], ['second', [75, 185, 45, 255]]]) {
    const bitmap = Buffer.alloc(512 * 128 * 4);
    for (let index = 0; index < bitmap.length; index += 4) bitmap.set(pixel, index);
    const fixture = path.join(output, `${name}.png`);
    await fs.writeFile(fixture, nativeImage.createFromBitmap(bitmap, { width: 512, height: 128 }).toPNG());
    fixtures.push(fixture);
  }
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  await checkpoint('开始构建页面');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    resolve: { dedupe: ['vue', 'pinia'] }, css: { postcss: { plugins: [tailwind()] } },
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  await checkpoint('页面构建完成');
  const window = new BrowserWindow({ width: 900, height: 740, show: false,
    webPreferences: { preload: path.join(output, 'preload.cjs'), contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const rendererErrors = [];
  window.webContents.on('console-message', event => { if (event.level >= 3) rendererErrors.push(event.message); });
  await window.webContents.session.clearStorageData({ storages: ['localstorage'] });
  let pickIndex = 0;
  const backgrounds = registerBackgroundImages({ ipcMain, nativeImage, userDataDir: app.getPath('userData'),
    getWindow: () => window, assertTrustedSender: event => event.sender === window.webContents,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [fixtures[pickIndex++ % fixtures.length]] }) } });
  const media = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }] });
  await window.loadFile(path.join(output, 'dist/index.html'));
  await checkpoint('页面加载完成');
  window.webContents.debugger.attach('1.3');
  await media('no-preference');
  await checkpoint('动画媒体设置完成');
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate('window.flush()');
  await checkpoint('页面初始化完成');
  const click = async selector => {
    assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `控件未找到：${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); window.flush()`);
  };
  const pick = async () => {
    await click('[data-testid=background-custom]');
    assert.equal(await evaluate('window.backgroundProbe().scrim'), '0.5');
    assert.equal(await evaluate('window.backgroundProbe().glow'), false);
    assert.match(await evaluate('window.backgroundProbe().image'), /data:image\/png;base64/);
  };
  const screenshot = async name => fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  const pixel = async (x = 20, y = 20) => [...(await window.webContents.capturePage({ x, y, width: 1, height: 1 })).toBitmap()];
  assert.equal(await evaluate('document.querySelector("#background-fit").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#background-scrim").disabled'), true);
  await pick();
  await checkpoint('首次选图完成');
  const first = await evaluate('window.backgroundProbe()');
  assert.equal((await fs.readdir(backgrounds.dir)).length, 1);
  await screenshot('settings-dark');
  await evaluate('window.setModal(false)');
  const firstPixel = await pixel();
  assert.ok(firstPixel.slice(0, 3).some(value => value > 20), '实际画布必须绘出图片');
  await evaluate('window.setModal(true)');
  await pick();
  await checkpoint('再次选图完成');
  const second = await evaluate('window.backgroundProbe()');
  assert.notEqual(second.image, first.image, '再次选图必须替换实际背景');
  assert.notEqual(second.preference.fileName, first.preference.fileName);
  assert.equal((await fs.readdir(backgrounds.dir)).length, 1, '换图后必须回收旧图片');
  await evaluate('window.setModal(false)');
  assert.notDeepEqual(await pixel(), firstPixel, '画布像素必须随图片变化');
  await evaluate('window.setModal(true)');
  await click('#background-fit');
  assert.equal(await evaluate('document.querySelector("#background-fit").getAttribute("aria-expanded")'), 'true');
  await screenshot('fit-menu-dark');
  await click('#background-fit-menu [data-value=contain]');
  assert.equal(await evaluate('window.backgroundProbe().fit'), 'contain');
  await evaluate('window.setModal(false)');
  assert.deepEqual((await pixel()).slice(0, 3), [0, 0, 0], '适应模式应留出真实画布空白');
  const beforeScrim = await pixel(450, 370);
  await evaluate('window.setModal(true)');
  await evaluate(`const slider=document.querySelector('#background-scrim');slider.value='80';slider.dispatchEvent(new Event('input',{bubbles:true}));window.flush()`);
  assert.equal(await evaluate('window.backgroundProbe().scrim'), '0.8');
  assert.equal(await evaluate('JSON.parse(window.backgroundProbe().stored).scrim'), 0.8);
  assert.equal(await evaluate('document.querySelector("output[for=background-scrim]").textContent'), '80%');
  await evaluate('window.setModal(false)');
  const afterScrim = await pixel(450, 370);
  assert.ok(afterScrim.slice(0, 3).some((value, index) => value < beforeScrim[index]), '增强遮罩必须真正压暗图片');
  await evaluate('window.setModal(true)');
  await new Promise(resolve => {
    window.webContents.once('did-finish-load', resolve);
    window.reload();
  });
  for (let attempt = 0; attempt < 50 && !await evaluate('typeof window.flush === "function"'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await evaluate('window.flush()');
  assert.equal(await evaluate('window.backgroundProbe().fit'), 'contain');
  assert.equal(await evaluate('window.backgroundProbe().scrim'), '0.8');
  await evaluate(`document.querySelector('[data-settings-tab=terms]').click();new Promise(resolve=>setTimeout(resolve,30))`);
  assert.ok(await evaluate('document.querySelector("[data-testid=settings-nav-indicator]").getAnimations().length > 0'), '选中背景必须有移动过渡');
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-settings-content]").length'), 1);
  assert.equal(await evaluate('document.querySelector("[data-settings-content]").dataset.settingsContent'), 'terms');
  await click('[data-settings-tab=general]');
  assert.equal(await evaluate('document.querySelector("#background-scrim").value'), '80');
  for (const width of [390, 900]) {
    window.setContentSize(width, 740);
    await evaluate('window.flush()');
    assert.equal(await evaluate(`(()=>{const panel=document.querySelector('[role=dialog]');return panel.scrollWidth<=panel.clientWidth+1})()`), true, '设置面板不能横向溢出');
    assert.equal(await evaluate(`(()=>{const content=document.querySelector('[data-settings-content]').parentElement;return content.scrollWidth<=content.clientWidth+1})()`), true, '按钮装饰光晕不能撑出内容区横向滚动条');
  }
  await evaluate('window.setDark(false)');
  await screenshot('settings-light');
  await click('#background-fit');
  await screenshot('fit-menu-light');
  await click('#background-fit-menu [data-value=cover]');
  await media('reduce');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-testid=settings-nav-indicator]")).transitionDuration'), '0s');
  await click('[data-testid=background-clear]');
  assert.equal(await evaluate('window.backgroundProbe().image'), 'none');
  assert.equal(await evaluate('window.backgroundProbe().scrim'), null);
  assert.equal(await evaluate('window.backgroundProbe().glow'), true);
  assert.equal(await evaluate('window.backgroundProbe().stored'), null);
  assert.equal((await fs.readdir(backgrounds.dir)).length, 0);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  assert.deepEqual(rendererErrors, []);
  backgrounds.close(); window.destroy(); clearTimeout(deadline);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, cases: [
    '真实 IPC 选图与换图、像素变化、旧图回收', '填充方式改变实际画布', '遮罩同步显示并持久化、重载恢复',
    '标签移动过渡、单一内容挂载、减少动态效果', '明暗渲染和窄屏布局', '清除图片、变量和偏好',
  ] }, null, 2));
  console.log('PASS 背景设置：真实 IPC 与画布像素、填充/遮罩、重载、标签动画、明暗与窄屏、清除');
  app.exit(0);
}).catch(async error => {
  await fs.writeFile(path.join(output, 'error.log'), String(error.stack));
  console.error(error); clearTimeout(deadline); app.exit(1);
});
