const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/chat-images');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('多图组件验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref } from 'vue';
import ChatInputArea from '../../../src/components/chat/ChatInputArea.vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import { readImagePreviews } from '../../../src/composables/useChatImageAttachments';
import { AgentAPI } from '../../../src/services/agent';
import { upsertTurnViewIntoMessages } from '../../../src/views/chat/blockProjection';
import '../../../src/style.css';
const input = ref(null);
const messages = ref([]);
window.reloadImages = urls => { messages.value = []; upsertTurnViewIntoMessages(messages.value,
  { sessionId:'42', turnId:'43', status:'COMPLETED', viewVersion:1, userMessage:'历史提问', userImageUrls:urls, blocks:[] }, new Map()); };
window.setText = text => input.value.setInputText(text);
async function send(text, plan, team, agent, images) {
  window.sent = { text, names:images.map(file => file.name) };
  const previews = await readImagePreviews(images);
  messages.value = [{id:'42', role:'user', content:text, timestamp:0, imageUrls:previews}];
  await AgentAPI.acceptCommand({ input:text, sessionId:'42', modelId:1, workspaceId:1, agentId:1, workDir:'', requirePlan:plan, image:images });
}
</script><template><main style="max-width:720px;margin:auto;padding:24px">
<ChatMessageItem v-for="message in messages.filter(m => m.role === 'user')" :key="message.id" :message="message" :is-dark="false" />
<ChatInputArea ref="input" :is-dark="false" @send-message="send" />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
import http from '../../../src/services/interceptor';
window.limitsFail = true; window.limit = 3; window.revoked = []; window.runtimeErrors=[];
window.addEventListener('error', event => window.runtimeErrors.push(event.error?.stack || event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(event.reason?.stack || String(event.reason)));
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
http.defaults.adapter = async config => {
  const data = config.url.includes('/limits') ? (window.limitsFail ? {code:0, errMsg:'限制读取失败'} : {code:1, data:{maxImages:window.limit}})
    : {code:1, data:{records:[],total:0,current:1,size:50}};
  return {config, status:200, statusText:'OK', headers:{}, data};
};
window.fetch = async (url, options) => { window.uploaded = options.body.getAll('image').map(file => file.name); return Response.json({code:1, data:{sessionId:'42',turnId:'43'}}); };
const {default:App} = await import('./App.vue');
let mounted = createApp(App); mounted.mount('#app');
window.unmount = () => mounted.unmount();
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve,30)); };
window.selectImages = async (names, paste=false) => {
  const transfer = new DataTransfer(); names.forEach((name,index) => {
    const canvas=document.createElement('canvas'); canvas.width=160; canvas.height=120;
    const context=canvas.getContext('2d'); context.fillStyle=index % 2 ? '#3b82f6' : '#10b981'; context.fillRect(0,0,160,120);
    context.fillStyle='white'; context.font='16px sans-serif'; context.fillText(name,12,64);
    const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),char=>char.charCodeAt(0));
    transfer.items.add(new File([bytes],name,{type:'image/png'}));
  });
  if(paste) document.querySelector('[contenteditable]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  else { const input = document.querySelector('input[type=file]'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); }
  await window.flush();
};
await window.flush(); window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 860, height: 780, show: false, webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.message?.includes('Error')) console.error(event.message); });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('window.ready === true')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('window.ready'), true);
  assert.equal(await evaluate('document.querySelector("input[type=file]").multiple'), true);
  assert.equal(await evaluate('document.querySelector("button[title=\\"正在读取图片数量限制\\"]").disabled'), true);
  await evaluate('window.limitsFail=false; [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "重试").click(); window.flush()');
  await evaluate('window.selectImages(["first.png", "second.png"])');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=image-attachments] img").length'), 2);
  await evaluate('window.selectImages(["third.png"],true)');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=image-attachments] img").length'), 3);
  await evaluate('window.selectImages(["fourth.png"])');
  assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /最多上传 3 张/);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=image-attachments] img").length'), 3);
  await evaluate('document.querySelector("button[aria-label=\\"移除 second.png\\"]").click(); window.flush()');
  assert.equal(await evaluate('window.revoked.length'), 1);
  await evaluate('window.setText("比较这些图片"); window.flush()');
  await evaluate('document.querySelector("button[aria-label=发送]").click(); window.flush()');
  assert.deepEqual(await evaluate('window.sent.names'), ['first.png', 'third.png']);
  assert.deepEqual(await evaluate('window.uploaded'), ['first.png', 'third.png']);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=image-attachments] img").length'), 0);
  assert.equal(await evaluate('window.revoked.length'), 3);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=user-images] img").length'), 2);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-testid=user-images] img")].every(img => img.src.startsWith("data:image/png;base64,"))'), true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await evaluate('[...document.querySelectorAll("[data-testid=user-images] img")].every(img => img.complete && img.naturalWidth > 0)'), true);
  await fs.writeFile(path.join(output, 'sent.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.reloadImages([...document.querySelectorAll("[data-testid=user-images] img")].map(img => img.src)); window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=user-images] img").length'), 2);
  await evaluate('window.selectImages(["only.png"])');
  await evaluate('document.querySelector("button[aria-label=发送]").click(); window.flush()');
  assert.deepEqual(await evaluate('window.uploaded'), ['only.png']);
  assert.match(await evaluate('window.sent.text'), /请分析并描述/);
  await evaluate('window.selectImages(["unmount.png"]); window.unmount()');
  assert.equal(await evaluate('window.revoked.length'), 5);
  await evaluate('window.flush()');
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('实际输入与消息组件：限制失败/重试、多选、批量粘贴、超限、移除、发送、历史多图及预览释放通过。');
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if(window) window.destroy(); app.exit(1); });
