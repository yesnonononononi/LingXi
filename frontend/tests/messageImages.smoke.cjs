const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {app, BrowserWindow} = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/message-images');
const mutation = process.env.LX_MESSAGE_IMAGE_MUTATION === 'renderer';
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let endpoint;
let vite;
let delayed;
let imageBytes;
let missingAvailable = false;
const deadline = setTimeout(() => { console.error('消息图片验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  endpoint = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/slow.png') { delayed = response; return; }
    const ok = request.url !== '/missing.png' || missingAvailable;
    response.writeHead(ok ? 200 : 404);
    response.end(ok ? imageBytes : 'missing');
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${endpoint.address().port}`;
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import {ref, nextTick} from 'vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import {useTheme} from '../../../src/composables/useTheme';
import {useI18n} from '../../../src/i18n';
import '../../../src/style.css';
const dark = ref(false);
const message = ref({id:'image-answer',role:'assistant',timestamp:0,content:'',isComplete:true});
useI18n().locale.value='zh-CN';
const {setTheme}=useTheme();
setTheme('light');
window.setMessage=async(content,running=false)=>{message.value.content=content;message.value.isThinking=running;message.value.isComplete=!running;await nextTick();};
window.setDark=async(value)=>{dark.value=value;setTheme(value?'dark':'light');await nextTick();};
</script><template><main style="max-width:720px;margin:24px auto;padding:0 16px"><ChatMessageItem :message="message" :is-dark="dark" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
window.runtimeErrors=[];window.addEventListener('error',event=>{if(event.message)window.runtimeErrors.push(event.message);});
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,120));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const {createServer} = await import('vite');
  const {default: vue} = await import('@vitejs/plugin-vue');
  vite = await createServer({configFile:false,root:output,plugins:[{
    name:'message-image-mutation',enforce:'pre',
    transform(source,id) {
      if (mutation && id.replaceAll('\\','/').endsWith('/src/components/chat/MarkdownContent.ts')) {
        return source.replace("node.localName === 'img'", 'false');
      }
    },
  },vue()],server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await vite.listen();
  window = new BrowserWindow({width:860,height:820,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const evaluate = source => window.webContents.executeJavaScript(source);
  await window.loadURL(vite.resolvedUrls.local[0]);
  for (let i=0;i<100;i++) {if(await evaluate('window.ready===true')) break;await new Promise(resolve=>setTimeout(resolve,50));}
  imageBytes = process.env.LX_MESSAGE_IMAGE_FIXTURE ? await fs.readFile(process.env.LX_MESSAGE_IMAGE_FIXTURE) : Buffer.from(await evaluate(`(() => {
    const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=800;const x=canvas.getContext('2d');
    x.fillStyle='#dbeafe';x.fillRect(0,0,1000,800);x.fillStyle='#2563eb';x.fillRect(0,620,1000,180);
    x.fillStyle='#ef4444';x.beginPath();x.moveTo(200,580);x.lineTo(800,580);x.lineTo(680,680);x.lineTo(320,680);x.fill();
    x.fillStyle='#fff';x.beginPath();x.moveTo(490,150);x.lineTo(490,560);x.lineTo(250,560);x.fill();return canvas.toDataURL('image/png').split(',')[1];
  })()`), 'base64');
  const render = async (content,running=false) => {await evaluate(`window.setMessage(${JSON.stringify(content)},${running});window.flush()`);};
  const waitFor = async source => {for(let i=0;i<100;i++){if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(`等待条件失败：${source}`);};
  const content = `这是生成的图片：\n\n![红色帆船](${base}/image.png)\n\n图片已经生成，可以点击预览。`;
  await render(content);
  await waitFor('document.querySelector("[data-testid=message-image] img")?.naturalWidth>0');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=message-image]").length'),1);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message-image-surface")).borderRadius'),'16px');
  assert.equal(await evaluate('document.querySelector(".message-image-placeholder")'),null);
  await evaluate('document.querySelector(".message-image-surface img").decode().then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  await new Promise(resolve=>setTimeout(resolve,180));
  await fs.writeFile(path.join(output,'light.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector(".message-image-surface").click();window.flush()');
  assert.equal(await evaluate('document.querySelector(".message-image-preview").open'),true);
  assert.equal(await evaluate('document.querySelector(".message-image-preview img").src'),`${base}/image.png`);
  await fs.writeFile(path.join(output,'preview.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector(".message-image-preview button").click();window.flush()');
  assert.equal(await evaluate('document.querySelector(".message-image-preview").open'),false);
  assert.equal(await evaluate('document.querySelector(".message-image-preview img")'),null);
  await evaluate('document.querySelector(".message-image-surface").click();window.flush()');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await waitFor('!document.querySelector(".message-image-preview").open');
  await evaluate('window.savedImage=document.querySelector(".message-image-surface img")');
  await render(content+'\n\n追加文字',true);
  assert.equal(await evaluate('window.savedImage===document.querySelector(".message-image-surface img")'),true);
  await evaluate('window.setDark(true);window.flush()');
  assert.equal(await evaluate('document.querySelector(".message-image").classList.contains("message-image--dark")'),true);
  await fs.writeFile(path.join(output,'dark.png'),(await window.webContents.capturePage()).toPNG());
  window.setSize(360,820);
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
  assert.equal(await evaluate('document.querySelector(".message-image-surface").getBoundingClientRect().width<=window.innerWidth-32'),true);
  await fs.writeFile(path.join(output,'narrow.png'),(await window.webContents.capturePage()).toPNG());
  await render(`![等待图片](${base}/slow.png)`);
  assert.match(await evaluate('document.querySelector(".message-image-placeholder").textContent'),/图片加载中/);
  for(let i=0;i<100&&!delayed;i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(delayed);
  delayed.end(imageBytes);
  await waitFor('!document.querySelector(".message-image-placeholder")');
  await render(`![失效图片](${base}/missing.png)`);
  await waitFor('document.querySelector(".message-image-retry")!==null');
  assert.match(await evaluate('document.querySelector(".message-image-placeholder").textContent'),/图片不可用/);
  missingAvailable=true;
  await evaluate('document.querySelector(".message-image-retry").click();window.flush()');
  await waitFor('document.querySelector(".message-image-surface img")?.naturalWidth>0');
  assert.equal(await evaluate('document.querySelector(".message-image-retry")'),null);
  await render(`![内嵌图片](data:image/png;base64,${imageBytes.toString('base64')})`);
  await waitFor('document.querySelector(".message-image-surface img")?.naturalWidth>0');
  await render(`[![带链接图片](${base}/image.png)](https://example.com/result)`);
  assert.equal(await evaluate('document.querySelector(".markdown-body a button")'),null);
  assert.equal(await evaluate('document.querySelector(".markdown-body a").href'),'https://example.com/result');
  await render('![危险地址](javascript:alert(1))');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=message-image]").length'),0);
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('消息图片：实际消息组件、加载/重试、预览、流式复用、深浅主题、窄屏、Data URL 与链接行为通过。');
  clearTimeout(deadline);window.destroy();await vite.close();endpoint.close();app.exit(0);
}).catch(async error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();if(vite)await vite.close();if(endpoint)endpoint.close();app.exit(1);});
