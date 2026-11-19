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
  // 重试与压缩现在是两条独立实现（各自组件、各自 class），但表现契约相同：
  // 都要是居中、扫光只落在文字上、深浅主题与窄屏都不溢出。这里按条分别量，别再把两条揉成一个选择器。
  const noticeBars = [
    { phase: 'retry', bar: '.retry-notice[role=status]', label: '.retry-notice-shimmer' },
    { phase: 'compress', bar: '.context-compact-bar[role=status]', label: '.context-compact-shimmer-text' },
  ];
  for (const dark of [false, true]) {
    await evaluate(`window.dark(${dark});window.flush()`);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    for (const width of [800, 360]) {
      window.setSize(width, 420);
      await evaluate('window.flush()');
      for (const notice of noticeBars) {
        const compressing = notice.phase === 'compress';
        if (compressing) {
          await emit({ type: 'CONTEXT_UPDATE', phase: 'SQUEEZE_STARTED', band: 'SUMMARY' });
          // 压缩条是淡入 + 上移 4px 进场的（transition 0.35s）。不等它落位就采样，
          // 两帧之间整条提示会移动，分隔线那种 1px 细线会被判成「文字之外有变化」。
          await evaluate('window.flush()');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(notice.bar)}).length`), 1,
          `${notice.phase} 提示必须渲染出来`);
        const layout = await evaluate(`(() => {
          const bar = document.querySelector(${JSON.stringify(notice.bar)});
          const label = bar.querySelector(${JSON.stringify(notice.label)});
          if (!label) return null;
          const bounds = bar.getBoundingClientRect();
          const content = label.parentElement.getBoundingClientRect();
          return { centerError: Math.abs(content.x + content.width / 2 - bounds.x - bounds.width / 2),
            overflow: content.left < bounds.left || content.right > bounds.right,
            gradient: getComputedStyle(label).backgroundImage,
            clip: getComputedStyle(label).backgroundClip };
        })()`);
        assert.ok(layout, `${notice.phase} 提示必须带居中扫光文案`);
        assert.ok(layout.centerError < 1 && !layout.overflow, JSON.stringify(layout));
        assert.ok(layout.gradient.includes(dark ? 'rgb(255, 255, 255)' : 'rgb(16, 24, 40)'));
        assert.equal(layout.clip, 'text');
        // 两帧截图必须用同一块矩形：重试提示里的倒计时文案会随时间变宽，
        // 每帧各自 getBoundingClientRect 会让两张位图尺寸不同，比像素就失去意义。
        const captureBox = await evaluate(`(() => {
          const bounds = document.querySelector(${JSON.stringify(notice.bar)}).getBoundingClientRect();
          return { x: Math.ceil(bounds.x), y: Math.ceil(bounds.y),
            width: Math.floor(bounds.width), height: Math.floor(bounds.height) };
        })()`);
        const paintedFrames = [];
        for (const cycle of [0, 1]) {
          for (const progress of [0.15, 0.35, 0.5, 0.65, 0.85]) {
            const sample = await evaluate(`(async () => {
              const bar = document.querySelector(${JSON.stringify(notice.bar)});
              const label = bar.querySelector(${JSON.stringify(notice.label)});
              const animations = [label.getAnimations()[0]];
              const timing = animations.map(animation => animation.effect.getTiming());
              animations.forEach((animation, index) => {
                animation.pause();
                animation.currentTime = timing[index].duration * (${cycle} + ${progress});
              });
              // 重试提示里的倒计时进度线本身就在随时间收缩，它不属于文字扫光。
              // 采样前把这些「装饰性动画」从绘制里摘掉（display:none 不会被 Vue 的渲染覆盖），
              // 剩下的图标、分隔线与背景仍参与比对，扫光漏到文字之外照样会失败。
              bar.querySelectorAll('*').forEach(node => {
                if (node === label) return;
                if (node.getAnimations().length === 0) return;
                node.style.display = 'none';
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
              paintedFrames.push({ ...sample, image: await window.webContents.capturePage(captureBox), bounds: captureBox });
            }
            if (cycle === 1 && progress === 0.5) {
              const name = `${notice.phase}-${dark ? 'dark' : 'light'}-${width}.png`;
              await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
            }
          }
        }
        const [before, after] = paintedFrames;
        const size = before.image.getSize();
        const first = before.image.toBitmap();
        const second = after.image.toBitmap();
        assert.equal(first.length, second.length);
        // 文字矩形取两帧的并集：重试提示的文字长度会变，只用某一帧的矩形会把另一帧的文字算成「文字之外」。
        const textBox = {
          left: Math.min(before.text.left, after.text.left),
          right: Math.max(before.text.right, after.text.right),
          top: Math.min(before.text.top, after.text.top),
          bottom: Math.max(before.text.bottom, after.text.bottom),
        };
        let changedText = 0;
        let changedOutside = 0;
        for (let y = 0; y < size.height; y++) {
          for (let x = 0; x < size.width; x++) {
            const offset = (y * size.width + x) * 4;
            if (first.subarray(offset, offset + 4).equals(second.subarray(offset, offset + 4))) continue;
            const pageX = before.bounds.x + (x + 0.5) * before.bounds.width / size.width;
            const pageY = before.bounds.y + (y + 0.5) * before.bounds.height / size.height;
            if (pageX >= textBox.left - 1 && pageX <= textBox.right + 1
                && pageY >= textBox.top - 1 && pageY <= textBox.bottom + 1) changedText++;
            else changedOutside++;
          }
        }
        assert.ok(changedText > 0, '截图必须捕捉到文字扫光的实际变化');
        assert.equal(changedOutside, 0, '文字之外的图标、分隔线和背景不能出现扫光');
        pixelChecks.push({ dark, width, compressing, changedText, changedOutside });
        // 压缩结束提示必须立刻消失；重试提示由 modelRetry 字段决定去留，这里不动它。
        if (compressing) {
          await emit({ type: 'CONTEXT_UPDATE', phase: 'SQUEEZE_COMPLETED', band: 'SUMMARY' });
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(notice.bar)}).length`), 0,
            '压缩结束必须撤掉压缩提示');
        }
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
