const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/read-image-tools');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('读图渲染验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const images = new Map();
  const requests = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    const image = images.get(request.url);
    response.writeHead(image ? 200 : 404, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
    response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref } from 'vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import { AgentToolName } from '../../../src/utils/toolNames';
import '../../../src/style.css';
const dark = ref(false);
const receipt = (imageId, path) => JSON.stringify({ok:true, images:[{imageId,ext:'png',path}]});
const message = ref({id:'answer',role:'assistant',timestamp:0,content:'已查看这两张图片。',isThinking:true,toolCalls:[
  {id:'1',toolName:AgentToolName.ReadImage,status:'success',order:1,args:{path:'screenshots/terminal.png'},result:receipt('0123456789abcdef','screenshots/terminal.png')},
  {id:'2',toolName:AgentToolName.ReadImage,status:'success',order:2,args:{path:'screenshots/editor.png'},result:JSON.stringify({outcome:'SUCCESS',output:receipt('fedcba9876543210','screenshots/editor.png')})}
]});
window.setDark = value => {dark.value=value; document.documentElement.classList.toggle('dark',value); document.body.style.background=value?'#18181b':'white';};
window.setStatus = status => message.value.toolCalls[1].status=status;
window.setMissing = () => message.value.toolCalls[1].result=receipt('0000000000000000','missing.png');
window.complete = () => {message.value.isThinking=false;message.value.isComplete=true;};
</script><template><main style="max-width:720px;margin:24px auto"><ChatMessageItem :message="message" session-id="42" :is-dark="dark" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
localStorage.setItem('lingxi_api_base_url',${JSON.stringify(base)});
window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,300));};
window.fixture = dark => {const c=document.createElement('canvas');c.width=320;c.height=220;const x=c.getContext('2d');
x.fillStyle=dark?'#18181b':'#fafafa';x.fillRect(0,0,320,220);x.fillStyle=dark?'#3f3f46':'#e4e4e7';x.fillRect(0,0,320,24);
for(let i=0;i<8;i++){x.fillStyle=i%3===0?'#60a5fa':dark?'#d4d4d8':'#71717a';x.fillRect(18,42+i*20,120+(i%3)*65,5);}return c.toDataURL('image/png');};
const {default:App}=await import('./App.vue'); createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({configFile:false,root:output,base:'./',plugins:[vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true}});
  window = new BrowserWindow({width:860,height:450,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const evaluate = source => window.webContents.executeJavaScript(source);
  // 页面先生成样图，再重新挂载，确保验证经过真实 HTTP 图片请求。
  await window.loadFile(path.join(output, 'dist/index.html'));
  for(let attempt=0;attempt<100;attempt++) { if(await evaluate('window.ready===true')) break; await new Promise(resolve=>setTimeout(resolve,50)); }
  for (const [id, dark] of [['0123456789abcdef',true],['fedcba9876543210',false]]) {
    images.set(`/a/images/42/${id}.png`, Buffer.from((await evaluate(`window.fixture(${dark})`)).split(',')[1], 'base64'));
  }
  await window.loadFile(path.join(output, 'dist/index.html'));
  for(let attempt=0;attempt<100;attempt++) { if(await evaluate('window.ready===true')) break; await new Promise(resolve=>setTimeout(resolve,50)); }
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=read-image-group]").length'), 1);
  assert.equal(await evaluate('document.querySelector("[data-testid=read-image-toggle]").textContent.trim()'), '已查看 2 张图像');
  assert.equal(await evaluate('[...document.querySelectorAll("[data-testid=read-image-thumbnails] img")].filter(img=>img.complete&&img.naturalWidth===320).length'), 2);
  assert.equal(requests.includes('/a/images/42/0123456789abcdef.png'), true);
  await fs.writeFile(path.join(output, 'light.png'), (await window.webContents.capturePage()).toPNG());
  const galleryBounds = await evaluate(`(() => {
    const group = document.querySelector('[data-testid=read-image-group]').getBoundingClientRect();
    const last = document.querySelector('[data-testid=read-image-thumbnails] button:last-child').getBoundingClientRect();
    return {x:Math.floor(group.left)-4,y:Math.floor(group.top)-4,width:Math.ceil(last.right-group.left)+8,height:Math.ceil(group.height)+8};
  })()`);
  await fs.writeFile(path.join(output, 'gallery.png'), (await window.webContents.capturePage(galleryBounds)).toPNG());
  await evaluate('document.querySelector("[data-testid=read-image-thumbnails] button").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("dialog").open'), true);
  assert.equal(await evaluate('document.querySelector("dialog img").naturalWidth'), 320);
  await evaluate('document.querySelector("dialog button").click();document.querySelector("[data-testid=read-image-toggle]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=read-image-toggle]").getAttribute("aria-expanded")'), 'false');
  assert.equal(await evaluate('document.querySelector("[data-testid=read-image-thumbnails]")'), null);
  await evaluate('document.querySelector("[data-testid=read-image-toggle]").click();window.setDark(true);window.flush()');
  await fs.writeFile(path.join(output, 'dark.png'), (await window.webContents.capturePage()).toPNG());
  await window.setSize(360,450);
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true);
  await fs.writeFile(path.join(output, 'narrow.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.setStatus("failed");window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=read-image-toggle]").textContent.trim()'), '已查看 1 张图像');
  assert.equal(await evaluate('document.body.textContent.includes("screenshots/editor.png")'), true);
  await evaluate('window.setStatus("success");window.setMissing();window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=read-image-thumbnails] button:disabled").length'), 1);
  assert.equal(await evaluate('document.body.textContent.includes("图片不可用")'), true);
  await evaluate('window.complete();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=read-image-group]")'), null);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('读图组件：相邻汇总、HTTP 缩略图、大图预览、折叠、深浅主题、窄屏、失败/失效与完成收起通过。');
  clearTimeout(deadline); window.destroy(); server.close(); app.exit(0);
}).catch(error => {console.error(error);clearTimeout(deadline);if(window)window.destroy();if(server)server.close();app.exit(1);});
