/**
 * 渲染层去回声用例（C17–C19）：`src/pet/main.ts` + `src/pet/hit/hit-view.ts`。
 *
 * <p><b>为什么不 import `main.ts` 跑行为：</b>它在模块末尾直接调 `boot()`（要 `window` / `document`），
 * 而本仓没有 jsdom。于是分两步走：把"命中状态 → 界面"抽成纯函数 `hit-view.ts`（行为在这里真跑），
 * 再接线的部分用源码形态断言钉死。两步合起来等价于"渲染层不再上报、UI 只由主进程驱动"。</p>
 *
 * <p>三条守卫：</p>
 * <ul>
 *   <li><b>C17</b>：`main.ts` 里不许再出现 `setHit(` / `reportHit(`，也不许有
 *       `mouseleave → reset()` 这条回声接线；`hit-pipeline.ts` 必须仍存在（防"顺手删模块+删用例"）；</li>
 *   <li><b>C18</b>：主进程说命中 ⇒ 根节点 `data-hit-source='main'`、徽标"可交互"，全程不需要任何本地鼠标事件；</li>
 *   <li><b>C19</b>：`new HitPipeline(` 必须落在 `DEBUG_ENABLED` 分支内（生产路径不跑诊断器）。</li>
 * </ul>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyHitView, HIT_BADGE_TEXT, HIT_SOURCE_MAIN } from '../src/pet/hit/hit-view';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 读一个前端文件。
 *
 * @param relative 相对 `frontend/` 的路径
 * @returns 文件内容
 */
function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * 取出"代码行"（去掉整行注释）。
 *
 * <p>注释里写"这里以前有 mouseleave→reset，现在是缺陷根因"是**有价值的历史**，
 * 要守的是代码里不许再出现那条接线。</p>
 *
 * @param source 源码
 * @returns 代码行数组（已去行尾空白）
 */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('//'));
}

/** 假 `classList`：只记账，不实现 CSS。 */
function makeClassList(): { toggle: (token: string, force?: boolean) => unknown; tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    toggle(token: string, force?: boolean): unknown {
      const index = tokens.indexOf(token);
      const want = force !== false;
      if (want && index < 0) tokens.push(token);
      if (!want && index >= 0) tokens.splice(index, 1);
      return want;
    },
  };
}

test('C17 main.ts 无命中上报：没有 setHit( / reportHit(，也没有 mouseleave → reset() 的回声接线', () => {
  const source = readSource('src/pet/main.ts');
  const code = codeLines(source);
  assert.equal(/\bsetHit\s*\(/.test(source), false, 'main.ts 不许再上报命中（pet:set-hit 通道已删）');
  assert.equal(/\breportHit\s*\(/.test(source), false, 'reportHit 是回声源，必须整体消失');
  // 回声接线：mouseleave 监听不许再出现在**代码**里（注释里讲历史可以）
  const mouseLeaveCode = code.filter((line) => line.includes('mouseleave'));
  assert.deepEqual(mouseLeaveCode, [], '代码里不许再有 mouseleave 监听（它把"切换穿透"误读成"光标离开"）');
  // 命中模块必须仍存在（删它会连带删掉 petHitTester 的 7 条既有用例 = 放宽基线）
  assert.equal(existsSync(join(ROOT, 'src/pet/hit/hit-pipeline.ts')), true, 'hit-pipeline.ts 必须保留');
  // UI 收口必须走纯函数模块
  assert.equal(source.includes('applyHitView'), true, 'main.ts 必须通过 applyHitView 更新界面');
  assert.equal(
    code.some((line) => line.includes('setIgnoreMouseEvents')),
    false,
    'main.ts 不许直接碰窗口穿透（那是主进程的事）',
  );
  assert.equal(
    code.some((line) => line.includes('hitPipeline?.schedule')),
    false,
    '代码里不许再把 mousemove 喂给诊断管线（生产路径无消费者）',
  );
});

test('C18 徽标由 hit-state 驱动：主进程说命中 ⇒ data-hit-source=main 且徽标"可交互"（无任何本地鼠标事件）', () => {
  const root = { dataset: {} as { hitSource?: string } };
  const art = { classList: makeClassList() };
  const badge = { classList: makeClassList(), textContent: '' as string | null };

  // 模拟收到 pet:command{type:'hit-state', hit:true}：只有一个来源，没有本地判定
  applyHitView({ root, art, badge }, true);
  assert.equal(root.dataset.hitSource, HIT_SOURCE_MAIN, '根节点必须标注命中来源是主进程');
  assert.equal(badge.textContent, HIT_BADGE_TEXT.interactive, '徽标必须是"可交互"');
  assert.equal(badge.classList.tokens.includes('is-hit'), true, '徽标必须带 is-hit');
  assert.equal(art.classList.tokens.includes('is-hit'), true, '立绘必须带 is-hit（光标自然变成手型）');

  // 反向：主进程说离开 ⇒ 全部回到穿透表现
  applyHitView({ root, art, badge }, false);
  assert.equal(badge.textContent, HIT_BADGE_TEXT.passThrough, '徽标必须回到"穿透中"');
  assert.equal(badge.classList.tokens.includes('is-hit'), false, '徽标必须去掉 is-hit');
  assert.equal(art.classList.tokens.includes('is-hit'), false, '立绘必须去掉 is-hit');
  assert.equal(root.dataset.hitSource, HIT_SOURCE_MAIN, '来源标注不随值变化（它描述的是"谁在驱动"）');

  // 幂等 + 空目标安全（DOM 还没建好时调用不许炸）
  applyHitView({ root, art, badge }, true);
  applyHitView({ root, art, badge }, true);
  assert.equal(badge.textContent, HIT_BADGE_TEXT.interactive, '重复同一状态结果一致');
  assert.doesNotThrow(() => applyHitView(null, true));
  assert.doesNotThrow(() => applyHitView({ root: null, art: null, badge: null }, false));
});

test('C23 即时触发器只叫醒不判定：main.ts 的 mousemove 只发 hoverHint，preload 只 send 不 invoke', () => {
  const mainSource = readSource('src/pet/main.ts');
  const mainCode = codeLines(mainSource);
  const preloadSource = readSource('electron/pet-preload.cjs');

  // ① 渲染层必须有 mousemove → hoverHint 这条触发链（否则手型会迟到一拍）
  const hintListener = mainCode.findIndex((line) => line.includes("'mousemove'"));
  assert.ok(hintListener >= 0, 'main.ts 必须监听 mousemove 并把它变成 hoverHint');
  // 只取这条监听的函数体（到它自己的 `);` 收尾为止），避免把后面的 pointerdown 处理体卷进来
  const hintEnd = mainCode.indexOf(');', hintListener);
  const hintWindow = mainCode.slice(hintListener, hintEnd > hintListener ? hintEnd + 1 : hintListener + 20).join('\n');
  assert.equal(hintWindow.includes('hoverHint('), true, `mousemove 处理体必须调用 hoverHint，实际：\n${hintWindow}`);
  // ② 触发链里不许出现本地判定（出现 hitTester 就是把判定权偷偷拿回来）
  assert.equal(
    hintWindow.includes('hitTester'),
    false,
    `mousemove 处理体不许碰命中实现（提示只叫醒，不判定），实际：\n${hintWindow}`,
  );
  assert.equal(hintWindow.includes('applyHitState'), false, 'mousemove 处理体不许直接改命中状态');

  // ③ preload 只 send（不等回执），且通道名唯一
  assert.equal(preloadSource.includes("ipcRenderer.send('pet:hover-hint'"), true, 'preload 必须用 send 发提示');
  assert.equal(
    preloadSource.includes("invoke('pet:hover-hint'"),
    false,
    '提示通道不许用 invoke（那是同步等待，会加延迟）',
  );
  assert.equal(preloadSource.includes('pet:set-hit'), false, 'setHit 通道必须彻底消失');

  // ④ 主进程侧：hint 处理器必须同步 poll()，且函数体里不许出现定时器、不许读载荷
  const windowSource = readSource('electron/pet-window.cjs');
  const hintIndex = windowSource.indexOf("ipcMain.on('pet:hover-hint'");
  assert.ok(hintIndex > 0, "pet-window.cjs 必须注册 'pet:hover-hint'");
  const handlerEnd = windowSource.indexOf('\n  });', hintIndex);
  const handlerBody = windowSource.slice(hintIndex, handlerEnd > hintIndex ? handlerEnd : hintIndex + 400);
  assert.equal(handlerBody.includes('poller?.poll()'), true, `hint 处理器必须当场 poll()（同步 apply），实际：\n${handlerBody}`);
  assert.equal(handlerBody.includes('setTimeout'), false, 'hint 处理器不许引入任何定时器');
  assert.equal(handlerBody.includes('payload'), false, 'hint 载荷不许被读取（读了就是把判定权还回去）');
});

test('C19 HitPipeline 仅调试档实例化：new HitPipeline( 必须落在 DEBUG_ENABLED 分支内', () => {
  const source = readSource('src/pet/main.ts');
  const index = source.indexOf('new HitPipeline(');
  assert.ok(index > 0, '找不到 new HitPipeline(（诊断器被整段删除？那会砍掉 7 条既有用例）');

  // 取前 6 行上下文：必须能看到 DEBUG_ENABLED 门
  const before = source.slice(0, index).split('\n').slice(-6).join('\n');
  assert.equal(
    before.includes('DEBUG_ENABLED'),
    true,
    `new HitPipeline( 必须落在 DEBUG_ENABLED 分支内，实际前文：\n${before}`,
  );

  // 构造器不再接手报告函数（onHitChange 只写诊断日志）
  assert.equal(source.includes('onHitChange: reportHit'), false, 'onHitChange 不许再指向已删除的 reportHit');
  // 二道门用的矩形实现必须仍然无条件创建（pointerdown / contextmenu 还靠它）
  const testerIndex = source.indexOf('new RectHitTester(');
  assert.ok(testerIndex > 0, 'RectHitTester 必须仍然存在（事件级二道门）');
  const testerBefore = source.slice(0, testerIndex).split('\n').slice(-3).join('\n');
  assert.equal(
    /if \(DEBUG_ENABLED\)/.test(testerBefore),
    false,
    'RectHitTester 不许被塞进调试分支（生产态也要用）',
  );
});
