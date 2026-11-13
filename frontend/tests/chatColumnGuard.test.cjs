const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 「右侧面板不许压扁对话列」的静态护栏。
 *
 * <p>真实缺陷（1024px 窗口，侧栏 256）：预览面板按默认 540 展开，对话列只剩 228px；
 * 输入卡片底部工具栏是 nowrap 的 450px 内容，于是卡片被撑破、按钮被列裁掉，
 * 消息被压成一条竖线。根因是两处宽度上限都拿 `window.innerWidth - 360/400` 算，
 * 都漏了左侧边栏，且只在拖拽那一刻生效（挂载与行宽变化时都不夹）。</p>
 *
 * <p>现在的契约：面板宽度上限只有一个算法（`utils/chatColumnLayout.ts` 的
 * `resolveSidePanelMaxWidth`：行宽 − 对话列最小宽度），两个面板都通过
 * `composables/useSidePanelWidthGuard` 夹紧，输入区工具栏允许换行。
 * 运行时证据在 `tests/chatNarrowColumn.smoke.cjs`（真 DOM 量宽度），这里守「没人绕开这套机制」。</p>
 */

const SRC = path.resolve(__dirname, '../src');
const read = rel => fs.readFileSync(path.resolve(SRC, rel), 'utf8');

/** 剥掉块注释与行注释：注释里提 `window.innerWidth - 360` 不算违规（本文件的说明就写着） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 剥掉 HTML/Vue 注释：注释里写类名不算消费 */
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/** 把面板宽度上限算成「窗口宽度减一个魔数」的写法（漏算侧边栏的元凶） */
const WINDOW_BASED_CLAMP = /window\.innerWidth\s*-\s*\d+/;

/**
 * 找出一段源码里「按窗口宽度夹紧面板」的行。
 *
 * <p>只认同一行同时出现 `panelWidth` 与 `window.innerWidth - N`：
 * `window.innerWidth` 本身在浮层定位里是正当用法（见 SessionContextUsage 的 tooltip 居中），
 * 一律禁掉会逼人为了过测试去改无关代码。</p>
 */
function findWindowBasedClampOffenders(source) {
  return source
    .split(/\r?\n/)
    .filter(line => line.includes('panelWidth') && WINDOW_BASED_CLAMP.test(line));
}

/** 递归列出 src 下的全部 .vue / .ts（不含 .d.ts） */
function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(vue|ts)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    files.push(full);
  }
  return files;
}

// G-1 金丝雀正对照：扫描器必须先能命中一个故意违规的样本，否则 G-2/G-3 的「0 处」不算数
test('G-1 金丝雀：窗口宽度式夹紧的扫描器能命中违规样本', () => {
  const violating = 'panelWidth.value = Math.min(window.innerWidth - 360, next);';
  assert.equal(findWindowBasedClampOffenders(violating).length, 1, '扫描器没命中违规样本，后续「0 处」结论无效');
  const violating400 = 'const maxAllowedWidth = Math.max(MIN, window.innerWidth - 400);\npanelWidth.value = nextWidth;';
  assert.equal(findWindowBasedClampOffenders(violating400).length, 0, '扫描器不该跨行拼接判定');
  const violatingSingleLine = 'panelWidth.value = Math.max(320, Math.min(window.innerWidth - 400, w));';
  assert.equal(findWindowBasedClampOffenders(violatingSingleLine).length, 1, '扫描器漏了 400 那档');
  const clean = 'panelWidth.value = clampWidth(candidate);';
  assert.equal(findWindowBasedClampOffenders(clean).length, 0, '扫描器把正常写法判成违规');
  const unrelated = 'const width = Math.min(naturalWidth, window.innerWidth - 16);';
  assert.equal(findWindowBasedClampOffenders(unrelated).length, 0, '浮层定位的窗口宽度用法不该被误判');
});

test('G-2 对话列最小宽度只定义一次，且是正数像素值', () => {
  const layout = stripComments(read('utils/chatColumnLayout.ts'));
  const match = /export const CHAT_COLUMN_MIN_WIDTH\s*=\s*(\d+)\s*;/.exec(layout);
  assert.notEqual(match, null, 'utils/chatColumnLayout.ts 必须导出 CHAT_COLUMN_MIN_WIDTH 常量');
  assert.ok(Number(match[1]) >= 320, `对话列最小宽度 ${match[1]}px 太小，输入区工具栏放不下`);
  assert.match(layout, /export function resolveSidePanelMaxWidth/, '面板宽度上限算法必须在这里，不允许各面板自己算');
});

test('G-3 src 里不存在「窗口宽度减魔数」式面板夹紧', () => {
  const offenders = [];
  for (const file of listSourceFiles(SRC)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const hits = findWindowBasedClampOffenders(source);
    if (hits.length > 0) offenders.push(`${path.relative(SRC, file)}: ${hits[0].trim()}`);
  }
  assert.deepEqual(offenders, [], `这些地方仍按窗口宽度算面板上限（漏算侧边栏）：\n${offenders.join('\n')}`);
});

test('G-4 两个右侧面板都走统一的宽度守卫', () => {
  const panels = [
    { rel: 'components/chat/FilePreviewPanel.vue', label: '文件预览面板' },
    { rel: 'components/chat/SubAgentSidePanel.vue', label: '子代理面板' }
  ];
  for (const panel of panels) {
    const source = read(panel.rel);
    assert.match(source, /useSidePanelWidthGuard\(/, `${panel.label} 未接入 useSidePanelWidthGuard`);
    assert.match(source, /const \{[^}]*clampWidth[^}]*\}\s*=\s*useSidePanelWidthGuard\(/, `${panel.label} 没有解构 clampWidth`);
    assert.ok(!/(panelWidth\.value\s*=\s*Math\.(min|max)\()/.test(source),
      `${panel.label} 仍在自己算宽度上下限，绕开了统一守卫`);
  }
});

test('G-5 文件预览面板的拖拽与键盘调宽都夹紧', () => {
  const source = stripComments(read('components/chat/FilePreviewPanel.vue'));
  assert.match(source, /panelWidth\.value\s*=\s*clampWidth\(/, '拖拽调宽必须走 clampWidth');
  const keyboard = source.match(/@keydown\.(left|right)\.prevent="[^"]*"/g) || [];
  assert.equal(keyboard.length, 2, '预览面板应保留左右两档键盘调宽');
  for (const handler of keyboard) {
    assert.match(handler, /clampWidth\(/, `键盘调宽没夹紧：${handler}`);
  }
  // 基于窗口宽度的上限已删除，CSS 里不许再留一份会与 JS 夹紧打架的上限
  assert.ok(!/max-width:\s*calc\(100vw/.test(source), '预览面板不得再写基于 100vw 的宽度上限');
});

test('G-6 子代理面板拖拽调宽走 clampWidth', () => {
  const source = stripComments(read('components/chat/SubAgentSidePanel.vue'));
  assert.match(source, /panelWidth\.value\s*=\s*clampWidth\(/, '拖拽调宽必须走 clampWidth');
});

test('G-7 输入区底部工具栏允许换行，不会把卡片撑破', () => {
  const template = stripHtmlComments(read('components/chat/ChatInputArea.vue'));
  assert.match(template, /justify-between\s+pt-1\s+flex-wrap/, '底部工具栏行必须是 flex-wrap');
  assert.ok(!/justify-between\s+pt-1\s+flex-nowrap/.test(template), '底部工具栏行改回 nowrap 会在窄列里撑破卡片');
});
