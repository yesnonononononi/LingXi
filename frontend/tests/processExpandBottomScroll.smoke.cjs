/**
 * 过程区下拉框在页面最底部展开时的防抖动守卫（offscreen Electron + 真实 DOM / Tailwind / useChatScroll）。
 *
 * <p>复现场景：消息列表处于最底部（`shouldAutoScroll === true`），用户点击底部过程区
 * `ChatProcessSegment` 展开按钮。若 `CollapseTransition` 的 enter-active 缺少
 * `overflow: clip`，子节点会在高度还是 0px 的首帧直接撑爆外层滚动容器的 `scrollHeight`，
 * 触发 `useChatScroll` 的 `ResizeObserver` 当帧把 `scrollTop` 拽到最终底部，表现为
 * 「整段对话向上瞬移、下方露出一块空白，随后内容再慢慢填进来」的展开抖动。</p>
 *
 * 运行：`cd frontend && npx electron tests/processExpandBottomScroll.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/process-expand-bottom-scroll');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('过程区底部展开防抖动守卫超时'); app.exit(1); }, 180000);

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });

  await fs.writeFile(path.join(fixture, 'app.css'),
    '@import "../../../src/style.css";\n@source "../../../src";\n');

  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import { ref, onMounted, nextTick } from 'vue';
import './app.css';
import ChatProcessSegment from '../../../src/components/chat/ChatProcessSegment.vue';
import ScrollCursorLoader from '../../../src/components/common/ScrollCursorLoader.vue';
import { useChatScroll } from '../../../src/views/chat/useChatScroll';
import { AgentToolName } from '../../../src/utils/toolNames';
import { setPreference } from '../../../src/i18n';

setPreference('zh-CN');

const scrollLoader = ref(null);
const {
  handleMessagesScroll,
  handleMessagesWheel,
  scrollToBottomForce,
  shouldAutoScroll,
} = useChatScroll({ messagesContainerRef: scrollLoader });

const message = {
  id: 'msg-bottom',
  role: 'assistant',
  turnId: 'turn-1',
  timestamp: 0,
  content: '已完成检查。',
  isComplete: true,
  isThinking: false,
  toolCalls: [],
};

const detailItems = Array.from({ length: 8 }, (_, index) => ({
  id: 'tool-' + index,
  kind: 'tool',
  toolCall: {
    id: 'call-' + index,
    toolName: AgentToolName.ReadFile,
    status: 'success',
    args: { path: 'src/components/ExampleFile' + index + '.vue' },
  },
}));

const view = {
  segment: {
    id: 'seg-1',
    detailItems,
  },
  mode: 'collapsed',
  headline: {
    title: '执行命令',
    preview: '共 8 项操作',
    previewKind: 'summary',
    status: '',
  },
};

onMounted(async () => {
  await nextTick();
  scrollToBottomForce('auto');
});

window.__isAutoScroll = () => shouldAutoScroll.value;
</script>
<template>
  <div class="w-[600px] h-[400px] bg-white flex flex-col">
    <ScrollCursorLoader
      ref="scrollLoader"
      data-testid="chat-scroll-box"
      class="flex-1 h-full p-4"
      direction="top"
      :hasMore="false"
      :loading="false"
      @scroll="handleMessagesScroll"
      @wheel="handleMessagesWheel"
    >
      <div class="space-y-3">
        <div class="h-[600px] rounded border border-zinc-200 p-3">上方历史消息占位</div>
        <ChatProcessSegment
          :view="view"
          :message="message"
          :is-dark="false"
          session-id="s1"
        />
      </div>
    </ScrollCursorLoader>
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');

window.flush = async (ms = 400) => {
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, ms));
};

window.clickToggleAndSample = (durationMs = 380) => new Promise(resolve => {
  const box = document.querySelector('[data-testid="chat-scroll-box"]');
  const toggle = document.querySelector('[data-testid="process-segment-toggle"]');
  const before = {
    scrollHeight: box.scrollHeight,
    scrollTop: box.scrollTop,
    clientHeight: box.clientHeight,
    toggleTop: Number(toggle.getBoundingClientRect().top.toFixed(2)),
  };
  toggle.click();
  const frames = [];
  const start = performance.now();
  const tick = () => {
    const details = document.querySelector('[data-testid="process-segment-details"]');
    const wrap = details ? details.parentElement : null;
    frames.push({
      t: Number((performance.now() - start).toFixed(1)),
      scrollHeight: box.scrollHeight,
      scrollTop: Number(box.scrollTop.toFixed(2)),
      toggleTop: Number(toggle.getBoundingClientRect().top.toFixed(2)),
      wrapH: wrap ? Number(wrap.getBoundingClientRect().height.toFixed(2)) : 0,
    });
    if (performance.now() - start < durationMs) {
      requestAnimationFrame(tick);
    } else {
      resolve({ before, frames });
    }
  };
  requestAnimationFrame(tick);
});

window.readState = () => {
  const box = document.querySelector('[data-testid="chat-scroll-box"]');
  const details = document.querySelector('[data-testid="process-segment-details"]');
  const wrap = details ? details.parentElement : null;
  const wrapStyle = wrap ? getComputedStyle(wrap) : null;
  return {
    scrollHeight: box.scrollHeight,
    scrollTop: Number(box.scrollTop.toFixed(2)),
    clientHeight: box.clientHeight,
    autoScroll: window.__isAutoScroll(),
    wrapOffsetH: wrap ? wrap.offsetHeight : 0,
    wrapScrollH: wrap ? wrap.scrollHeight : 0,
    wrapMarginTop: wrapStyle ? wrapStyle.marginTop : null,
  };
};

window.ready = true;`);

  await fs.writeFile(path.join(fixture, 'index.html'),
    '<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build, preview } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const tailwind = (await import('@tailwindcss/postcss')).default;
  const autoprefixer = (await import('autoprefixer')).default;
  await build({
    configFile: false, root: fixture, base: './', plugins: [vue()], logLevel: 'error',
    css: { postcss: { plugins: [tailwind(), autoprefixer()] } },
    build: { outDir: path.join(fixture, 'dist'), emptyOutDir: true },
  });
  server = await preview({
    configFile: false, root: fixture,
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
    build: { outDir: path.join(fixture, 'dist') },
  });

  window = new BrowserWindow({
    show: false, width: 720, height: 520,
    webPreferences: { offscreen: true, contextIsolation: true },
  });
  await window.loadURL(server.resolvedUrls.local[0]);

  const evalJs = code => window.webContents.executeJavaScript(code, true);
  while (!(await evalJs('Boolean(window.ready)'))) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await evalJs('window.flush(150)');

  const initial = await evalJs('window.readState()');
  assert.equal(initial.autoScroll, true, '初始应处于页面最底部自动跟随状态');
  assert.ok(
    Math.abs((initial.scrollHeight - initial.clientHeight) - initial.scrollTop) <= 2,
    '初始应贴底: ' + JSON.stringify(initial)
  );

  const expand = await evalJs('window.clickToggleAndSample(400)');
  const steady = await evalJs('window.readState()');
  const totalDelta = steady.scrollHeight - expand.before.scrollHeight;
  assert.ok(totalDelta > 150, '展开后内容应显著增高，实际增量: ' + totalDelta);

  // 检查展开过程首几帧是否有「高度还是 0/很小，但 scrollHeight/scrollTop 已整块跳走」的抖动。
  let prevScrollH = expand.before.scrollHeight;
  let prevToggleTop = expand.before.toggleTop;
  let maxFrameJump = 0;
  let maxToggleJump = 0;
  for (const frame of expand.frames) {
    const jumpH = frame.scrollHeight - prevScrollH;
    const jumpToggle = Math.abs(frame.toggleTop - prevToggleTop);
    if (jumpH > maxFrameJump) maxFrameJump = jumpH;
    if (jumpToggle > maxToggleJump) maxToggleJump = jumpToggle;
    prevScrollH = frame.scrollHeight;
    prevToggleTop = frame.toggleTop;
  }

  console.log(JSON.stringify({
    before: expand.before,
    first3Frames: expand.frames.slice(0, 3),
    steady,
    totalDelta,
    maxFrameJump,
    maxToggleJump,
  }, null, 2));

  assert.ok(
    maxFrameJump <= totalDelta * 0.45,
    `展开过程单帧 scrollHeight 跳变过大 (${maxFrameJump}px / 总增量 ${totalDelta}px)，说明未裁剪子树溢出导致瞬跳`
  );
  assert.ok(
    maxToggleJump <= totalDelta * 0.45,
    `展开过程单帧按钮位置跳变过大 (${maxToggleJump}px / 总增量 ${totalDelta}px)`
  );
  assert.ok(
    Math.abs(steady.wrapOffsetH - steady.wrapScrollH) <= 1,
    '稳态高度应与 scrollHeight 一致: ' + JSON.stringify(steady)
  );
  assert.ok(
    Math.abs((steady.scrollHeight - steady.clientHeight) - steady.scrollTop) <= 2,
    '展开完成后应仍贴底: ' + JSON.stringify(steady)
  );
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  try { window?.destroy(); } catch {}
  try { await server?.httpServer?.close(); } catch {}
  app.exit(process.exitCode || 0);
});
