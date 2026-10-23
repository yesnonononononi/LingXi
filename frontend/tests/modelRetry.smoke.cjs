const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/model-retry');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('重试提示验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { reactive, computed } from 'vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import { TurnStreamReducer } from '../../../src/views/chat/turnStreamReducer';
import { useI18n } from '../../../src/i18n';
import { useTheme } from '../../../src/composables/useTheme';
import '../../../src/style.css';
const messages = reactive([]);
const { isDark, setTheme } = useTheme();
const reducer = new TurnStreamReducer(() => messages, {sessionId:'7'});
const message = computed(() => messages.find(item => item.role === 'assistant'));
window.emitEvent = event => reducer.consume(event);
window.snapshot = () => JSON.parse(JSON.stringify(message.value));
window.language = useI18n().setPreference;
window.dark = value => setTheme(value ? 'dark' : 'light');
window.dark(false);
</script><template><main style="max-width:680px;margin:24px auto"><ChatMessageItem v-if="message" :message="message" :is-dark="isDark" session-id="7" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.runtimeErrors=[];window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,150));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 800, height: 420, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100 && !await evaluate('window.ready === true'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('window.ready'), true);
  const metaData = { sessionId: '7', turnId: '9007199254741000' };
  const emit = event => evaluate(`window.emitEvent(${JSON.stringify({ executionId: 'e', timestamp: '', metaData, ...event })});window.flush()`);
  await emit({ type: 'EXECUTION_STARTED' });
  await emit({ type: 'PARTIAL_TEXT', responseId: '9007199254740992', offset: 0, order: 1, content: '未完成片段' });
  await emit({ type: 'INVOKE_RETRY', responseId: '9007199254740992', retryCount: 1, retryDelay: 750, timeUnit: 'MILLISECONDS' });
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'), '请求暂时失败，正在第 1 次重试…');
  assert.equal(await evaluate('document.body.textContent.includes("未完成片段")'), false);
  assert.equal((await evaluate('window.snapshot()')).isComplete, false);
  const animationChecks = [];
  const pixelChecks = [];
  for (const dark of [false, true]) {
    await evaluate(`window.dark(${dark});window.flush()`);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    for (const width of [800, 360]) {
      window.setSize(width, 420);
      await evaluate('window.flush()');
      for (const compressing of [false, true]) {
        await emit({ type: 'CONTEXT_UPDATE', phase: compressing ? 'SQUEEZE_STARTED' : 'SQUEEZE_COMPLETED', band: 'SUMMARY' });
        assert.equal(await evaluate('document.querySelectorAll(".context-compact-bar[role=status]").length'), 1);
        const layout = await evaluate(`(() => {
          const bar = document.querySelector('.context-compact-bar[role=status]');
          const label = bar.querySelector('.context-compact-shimmer-text');
          if (!label) return null;
          const bounds = bar.getBoundingClientRect();
          const content = label.parentElement.getBoundingClientRect();
          return { centerError: Math.abs(content.x + content.width / 2 - bounds.x - bounds.width / 2),
            overflow: content.left < bounds.left || content.right > bounds.right,
            gradient: getComputedStyle(label).backgroundImage,
            clip: getComputedStyle(label).backgroundClip };
        })()`);
        assert.ok(layout, '重试与压缩必须共用居中扫光提示栏');
        assert.ok(layout.centerError < 1 && !layout.overflow, JSON.stringify(layout));
        assert.ok(layout.gradient.includes(dark ? 'rgb(255, 255, 255)' : 'rgb(16, 24, 40)'));
        assert.equal(layout.clip, 'text');
        const paintedFrames = [];
        for (const cycle of [0, 1]) {
          for (const progress of [0.15, 0.35, 0.5, 0.65, 0.85]) {
            const sample = await evaluate(`(async () => {
              const bar = document.querySelector('.context-compact-bar[role=status]');
              const label = bar.querySelector('.context-compact-shimmer-text');
              const animations = [label.getAnimations()[0]];
              const timing = animations.map(animation => animation.effect.getTiming());
              animations.forEach((animation, index) => {
                animation.pause();
                animation.currentTime = timing[index].duration * (${cycle} + ${progress});
              });
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const style = getComputedStyle(label);
              const size = parseFloat(style.backgroundSize) / 100;
              const position = parseFloat(style.backgroundPositionX) / 100;
              const bounds = bar.getBoundingClientRect();
              const text = label.getBoundingClientRect();
              return { textCenter: size / 2 + (1 - size) * position,
                bounds: { x: Math.ceil(bounds.x), y: Math.ceil(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) },
                text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
                periods: timing.map(value => value.duration),
                repeats: timing.map(value => value.iterations === Infinity) };
            })()`);
            const expected = 2 * progress - 0.5;
            assert.ok(Math.abs(sample.textCenter - expected) < 0.02, `文字扫光偏离位置: ${JSON.stringify(sample)}`);
            assert.deepEqual(sample.repeats, [true]);
            animationChecks.push({ dark, width, compressing, cycle, progress, ...sample });
            if (cycle === 1 && (progress === 0.15 || progress === 0.5)) {
              paintedFrames.push({ image: await window.webContents.capturePage(sample.bounds), ...sample });
            }
            if (cycle === 1 && progress === 0.5) {
              const name = `${compressing ? 'compress' : 'retry'}-${dark ? 'dark' : 'light'}-${width}.png`;
              await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
            }
          }
        }
        const [before, after] = paintedFrames;
        const size = before.image.getSize();
        const first = before.image.toBitmap();
        const second = after.image.toBitmap();
        assert.equal(first.length, second.length);
        let changedText = 0;
        let changedOutside = 0;
        for (let y = 0; y < size.height; y++) {
          for (let x = 0; x < size.width; x++) {
            const offset = (y * size.width + x) * 4;
            if (first.subarray(offset, offset + 4).equals(second.subarray(offset, offset + 4))) continue;
            const pageX = before.bounds.x + (x + 0.5) * before.bounds.width / size.width;
            const pageY = before.bounds.y + (y + 0.5) * before.bounds.height / size.height;
            if (pageX >= before.text.left - 1 && pageX <= before.text.right + 1
                && pageY >= before.text.top - 1 && pageY <= before.text.bottom + 1) changedText++;
            else changedOutside++;
          }
        }
        assert.ok(changedText > 0, '截图必须捕捉到文字扫光的实际变化');
        assert.equal(changedOutside, 0, '文字之外的图标、分隔线和背景不能出现扫光');
        pixelChecks.push({ dark, width, compressing, changedText, changedOutside });
      }
    }
  }
  await fs.writeFile(path.join(output, 'animation-checks.json'), JSON.stringify(animationChecks, null, 2));
  await fs.writeFile(path.join(output, 'pixel-checks.json'), JSON.stringify(pixelChecks, null, 2));
  await emit({ type: 'CONTEXT_UPDATE', phase: 'SQUEEZE_COMPLETED', band: 'SUMMARY' });
  await evaluate('window.language("en-US");window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'), 'Request temporarily failed. Retrying (1)…');
  await emit({ type: 'PARTIAL_TEXT', responseId: '9007199254740992', offset: 0, order: 1, content: '旧回调' });
  assert.equal(await evaluate('document.body.textContent.includes("旧回调")'), false);
  await emit({ type: 'AI_MESSAGE', responseId: '9007199254740993', text: '恢复成功', order: 1, isBody: true });
  assert.equal(await evaluate('document.querySelector("[role=status]:not(.context-compact-fade-leave-active)")'), null);
  assert.equal((await evaluate('window.snapshot()')).content, '恢复成功');
  await emit({ type: 'EXECUTION_COMPLETED' });
  assert.equal((await evaluate('window.snapshot()')).isComplete, true);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('重试与压缩组件通过：同款居中提示、深浅主题、窄屏、连续两轮从左到右扫光、双语和成功接续。');
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
