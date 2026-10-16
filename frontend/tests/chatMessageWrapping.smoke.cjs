const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/chat-message-wrapping');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('消息换行验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import ChatMessageList from '../../../src/components/chat/ChatMessageList.vue';
import { useTheme } from '../../../src/composables/useTheme';
import '../../../src/style.css';
const messages = ref([]);
const dark = ref(false);
const compact = ref(false);
const transcript = ref(null);
const { setTheme } = useTheme();
window.setMessage = async (text, options = {}) => {
  dark.value = !!options.dark; compact.value = !!options.compact;
  setTheme(dark.value ? 'dark' : 'light');
  messages.value = [{ id: 'wrap-test', role: 'user', content: text, timestamp: 0,
    imageUrls: options.image ? ['data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#3384dd"/></svg>')] : [] }];
  await nextTick(); await new Promise(resolve => setTimeout(resolve, 180));
  transcript.value.scrollToTop('instant');
};
</script><template><main style="display:flex;height:100vh;min-width:0">
<aside v-if="!compact" style="flex:0 0 220px;background:#f5f6f8"></aside>
<section style="display:flex;flex:1;min-width:0;flex-direction:column">
<ChatMessageList ref="transcript" :messages="messages" :is-dark="dark" :compact="compact" />
</section></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');
window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  assert.equal(await evaluate('window.ready'), true);
  const cases = [
    ['url', '这是一个很长的链接：https://example.test/work?' + 'courseId=1234567890&enc=' + 'a1b2c3d4'.repeat(120)],
    ['token', 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(100)],
    ['chinese', '长消息应当在聊天气泡内换行，不应撑开页面。'.repeat(70)],
    ['whitespace', '# 原样文本\n\n  缩进保留 **Markdown** <div>HTML</div>\n' + 'x'.repeat(500)],
    ['image', '图片下面的长链接：https://example.test/?token=' + 'a1b2c3'.repeat(140)],
  ];
  const measurements = [];
  for (const [label, width, options] of [
    ['desktop', 1200, {}], ['narrow', 580, {}], ['compact', 360, { compact: true, dark: true }],
  ]) {
    window.setContentSize(width, 800);
    for (const [name, text] of cases) {
      await evaluate(`window.setMessage(${JSON.stringify(text)}, ${JSON.stringify({ ...options, image: name === 'image' })})`);
      const geometry = await evaluate(`(() => {
        const group = document.querySelector('[data-testid=user-message]');
        const bubble = document.querySelector('[data-testid=user-message-bubble]');
        const text = document.querySelector('[data-testid=user-message-text]');
        const row = group.parentElement;
        const bounds = element => { const b = element.getBoundingClientRect(); return {left:b.left, right:b.right, width:b.width, height:b.height}; };
        const range = document.createRange(); range.selectNodeContents(text);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        return { group:bounds(group), bubble:bounds(bubble), row:bounds(row), text:bounds(text),
          lines:[...new Set(rects.map(rect => Math.round(rect.top)))].length,
          textRight:Math.max(...rects.map(rect => rect.right)),
          textLeft:Math.min(...rects.map(rect => rect.left)),
          documentWidth:document.documentElement.scrollWidth, viewport:innerWidth,
          textContent:text.textContent.trim(), imageCount:bubble.querySelectorAll('img').length };
      })()`);
      measurements.push({ label, name, ...geometry });
      await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
      if (name === 'url') await fs.writeFile(path.join(output, `${label}.png`), (await window.webContents.capturePage()).toPNG());
      assert.ok(geometry.group.width <= Math.min(672, geometry.row.width) + 1, `${label}/${name}: 气泡超过消息列宽度`);
      assert.ok(geometry.bubble.left >= geometry.row.left - 1 && geometry.bubble.right <= geometry.row.right + 1,
        `${label}/${name}: 气泡溢出消息列 ${JSON.stringify(geometry)}`);
      assert.ok(geometry.textLeft >= geometry.text.left - 1 && geometry.textRight <= geometry.text.right + 1,
        `${label}/${name}: 文本溢出或被裁剪`);
      assert.ok(geometry.lines > 1, `${label}/${name}: 长消息没有换行`);
      assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${label}/${name}: 撑宽了页面`);
      assert.equal(geometry.textContent, text, `${label}/${name}: 文本内容发生变化`);
      assert.equal(geometry.imageCount, name === 'image' ? 1 : 0);
    }
    await evaluate('window.setMessage("短消息", ' + JSON.stringify(options) + ')');
    assert.ok(await evaluate('document.querySelector("[data-testid=user-message-bubble]").getBoundingClientRect().width < 150'), '短消息不应强制占满整行');
  }
  const original = cases[3][1];
  await evaluate(`window.setMessage(${JSON.stringify(original)})`);
  await evaluate('Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedText = text; } } }); document.querySelector("[data-testid=user-message] button").click()');
  assert.equal(await evaluate('window.copiedText'), original, '复制必须保持原文');
  console.log(`真实消息列表：${measurements.length} 种宽度/文本组合、短消息、图片和复制原文验证通过。截图：${output}`);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
