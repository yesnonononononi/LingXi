/**
 * 微动态与视觉层单测（tsx 执行，不碰 DOM 元素；CSS 只读文件文本）。
 *
 * <p>两条主线：</p>
 * <ol>
 *   <li><b>纯函数</b>：功耗档位时长乘数、光晕几何、调试/标定开关解析、锚点归一化；</li>
 *   <li><b>CSS 契约</b>：关键帧、`data-power` 四档、调试 UI 的发布态隐藏、参数驱动变量的
 *       变量名与 `DRIVEN_CSS_VARIABLES` 一致。CSS 没有类型系统，只能靠断言钉住。</li>
 * </ol>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PET_GEOMETRY, artBox } from '../src/pet/layout';
import { MOTION_RECIPES } from '../src/pet/presentation/command-router';
import { DRIVEN_CSS_VARIABLES } from '../src/pet/presentation/sprite-presentation';
import { DRIVEN_PARAMS } from '../src/pet/presentation/types';
import { PowerPolicy, resolvePower } from '../src/pet/power-policy';
import {
  CALIBRATION_ANCHOR_DEFAULTS,
  clampAnchorValue,
  isCalibrationEnabled,
  normalizeAnchor,
  serializeAnchors,
} from '../src/pet/visual/calibrate';
import { HALO_BOTTOM_PX, HALO_HEIGHT_PX, HALO_WIDTH_RATIO, applyHaloVariables, haloBox } from '../src/pet/visual/halo';
import {
  BASE_MOTION_TIMING,
  MOTION_DURATION_VARIABLES,
  POWER_DURATION_MULTIPLIER,
  REDUCED_MOTION_QUERY,
  isDebugEnabled,
  motionAnimationMs,
  motionTiming,
  parseQueryFlag,
  prefersReducedMotion,
} from '../src/pet/visual/micro-motion';
import {
  MOTION_ACTIVE_MAX_MS,
  MOTION_ACTIVE_MIN_MS,
  MOTION_REST_ATTRIBUTE,
  MOTION_REST_MAX_MS,
  MOTION_REST_MIN_MS,
  MOTION_REST_PROBABILITY,
  MotionPacer,
  nextMotionPace,
} from '../src/pet/visual/motion-pacer';
import type { TimerPort } from '../src/pet/presentation/bus';

/** 可控时钟 + 定时器（把节奏推进变成同步断言）。 */
class FakeTimer implements TimerPort {
  /** 当前虚拟时间（毫秒）。 */
  private time = 0;

  /** 自增句柄。 */
  private seq = 0;

  /** 待执行任务。 */
  private readonly tasks = new Map<number, { at: number; handler: () => void }>();

  /**
   * 注册定时器。
   *
   * @param handler 回调
   * @param delayMs 延迟
   * @returns 句柄
   */
  setTimeout(handler: () => void, delayMs: number): number {
    this.seq += 1;
    this.tasks.set(this.seq, { at: this.time + delayMs, handler });
    return this.seq;
  }

  /**
   * 取消定时器。
   *
   * @param handle 句柄
   */
  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  /**
   * 推进虚拟时间并执行到期任务。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, task] of [...this.tasks.entries()]) {
      if (task.at <= this.time) {
        this.tasks.delete(id);
        task.handler();
      }
    }
  }

  /**
   * 待执行任务数。
   *
   * @returns 数量
   */
  pending(): number {
    return this.tasks.size;
  }
}

/**
 * `pet.css` 全文（CSS 契约断言用）。
 *
 * <p>断言前先剥掉注释：注释里出现的 `scale(1.014)`、`display:none` 只是说明文字，
 * 不该被当成"还在用旧写法"（否则改一句话就得改测试）。</p>
 */
const CSS = readFileSync(resolve(process.cwd(), 'src/pet/pet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------- 功耗四档

test('resolvePower：不可见 → off，页面隐藏 → low，拖拽/焦点 → interactive，其余 idle', () => {
  assert.equal(resolvePower({ visible: false, focused: false, dragging: false, reducedMotion: false }), 'off');
  assert.equal(resolvePower({ visible: true, hidden: true, focused: false, dragging: false, reducedMotion: false }), 'low');
  assert.equal(resolvePower({ visible: true, focused: false, dragging: true, reducedMotion: false }), 'interactive');
  assert.equal(resolvePower({ visible: true, focused: true, dragging: false, reducedMotion: false }), 'interactive');
  assert.equal(resolvePower({ visible: true, focused: false, dragging: false, reducedMotion: false }), 'idle');
  // 优先级：off 压过一切
  assert.equal(resolvePower({ visible: false, hidden: true, focused: true, dragging: true, reducedMotion: true }), 'off');
});

test('motionTiming：low 档时长 ×2，off 档暂停', () => {
  const idle = motionTiming('idle');
  assert.equal(idle.breathMs, BASE_MOTION_TIMING.breathMs);
  assert.equal(idle.swayMs, BASE_MOTION_TIMING.swayMs);
  assert.equal(idle.playState, 'running');

  const low = motionTiming('low');
  assert.equal(low.breathMs, BASE_MOTION_TIMING.breathMs * 2);
  assert.equal(low.swayMs, BASE_MOTION_TIMING.swayMs * 2);
  assert.equal(low.playState, 'running');

  const off = motionTiming('off');
  assert.equal(off.playState, 'paused');
  assert.equal(POWER_DURATION_MULTIPLIER.interactive, 1);
  assert.equal(POWER_DURATION_MULTIPLIER.low, 2);
});

test('基准时长与 CSS 静态默认值一致（首帧兜底不能漂移）', () => {
  assert.ok(CSS.includes('var(--pet-breath-ms, 3.6s)'), 'pet.css 的呼吸默认值应为 3.6s');
  assert.ok(CSS.includes('var(--pet-sway-ms, 5.2s)'), 'pet.css 的摇摆默认值应为 5.2s');
  assert.ok(CSS.includes('var(--pet-ahoge-ms, 2.6s)'), 'pet.css 的呆毛默认值应为 2.6s');
  assert.equal(BASE_MOTION_TIMING.breathMs, 3600);
  assert.equal(BASE_MOTION_TIMING.swayMs, 5200);
  assert.equal(BASE_MOTION_TIMING.ahogeMs, 2600);
});

test('motionAnimationMs：动作时长与配方表同源（tap=480ms）', () => {
  assert.equal(motionAnimationMs('tap'), 480);
  assert.equal(motionAnimationMs('tap'), MOTION_RECIPES.tap.motionMs);
  assert.equal(motionAnimationMs('surprised'), 600);
  // idle/drag 没有时长（循环）→ 回落 480，避免 CSS 拿到 undefined
  assert.equal(motionAnimationMs('idle'), 480);
});

test('PowerPolicy：只在档位变化时通知订阅者', () => {
  const policy = new PowerPolicy({ visible: true });
  const seen: string[] = [];
  const off = policy.onPower((power) => seen.push(power));
  assert.equal(policy.power, 'idle');
  policy.update({ dragging: true });
  policy.update({ dragging: true });
  policy.update({ dragging: false });
  policy.update({ visible: false });
  assert.deepEqual(seen, ['interactive', 'idle', 'off']);
  off();
  policy.update({ visible: true });
  assert.deepEqual(seen, ['interactive', 'idle', 'off'], '取消订阅后不应再收到');
  policy.dispose();
});

// ---------------------------------------------------------------- 光晕

test('haloBox：贴地、居中、宽度取立绘箱 62%，且完全落在立绘箱内', () => {
  const box = artBox(PET_GEOMETRY);
  const halo = haloBox(PET_GEOMETRY);
  assert.equal(halo.width, box.width * HALO_WIDTH_RATIO);
  assert.equal(halo.height, HALO_HEIGHT_PX);
  // 居中对齐
  assert.ok(Math.abs(halo.x + halo.width / 2 - (box.x + box.width / 2)) < 0.001);
  // 底边距立绘箱底边 HALO_BOTTOM_PX
  assert.ok(Math.abs(halo.y + halo.height - (box.y + box.height - HALO_BOTTOM_PX)) < 0.001);
  // 不越出立绘箱（越出会被窗口边缘切掉）
  assert.ok(halo.x >= box.x && halo.x + halo.width <= box.x + box.width);
});

test('applyHaloVariables：写入的百分比与常量一致', () => {
  const style = new Map<string, string>();
  const host = {
    style: { setProperty: (name: string, value: string) => style.set(name, value) },
  } as unknown as HTMLElement;
  applyHaloVariables(host, PET_GEOMETRY);
  assert.equal(style.get('--pet-halo-w'), '62.00%');
  assert.equal(style.get('--pet-halo-h'), '14px');
  assert.equal(style.get('--pet-halo-bottom'), '2px');
  assert.equal(style.get('--pet-halo-opacity'), '0.55');
  // CSS 里的兜底值必须与这里一致
  assert.ok(CSS.includes('var(--pet-halo-h, 14px)'));
  assert.ok(CSS.includes('var(--pet-halo-bottom, 2px)'));
  assert.ok(CSS.includes('var(--pet-halo-opacity, 0.55)'));
});

// ---------------------------------------------------------------- 开关解析

test('isDebugEnabled：dev 恒开，发布态只有 ?debug=1 开', () => {
  assert.equal(isDebugEnabled('', true), true);
  assert.equal(isDebugEnabled('', false), false);
  assert.equal(isDebugEnabled('?debug=1', false), true);
  assert.equal(isDebugEnabled('?debug=true', false), true);
  assert.equal(isDebugEnabled('?debug=0', false), false);
  assert.equal(isDebugEnabled('?calibrate=1', false), false);
});

test('parseQueryFlag：容忍没有前导 ? 与多余参数', () => {
  assert.equal(parseQueryFlag('debug=1', 'debug'), true);
  assert.equal(parseQueryFlag('?a=1&debug=1&b=2', 'debug'), true);
  assert.equal(parseQueryFlag('?a=1', 'debug'), false);
  assert.equal(parseQueryFlag('', 'debug'), false);
});

test('isCalibrationEnabled：只认 ?calibrate=1', () => {
  assert.equal(isCalibrationEnabled('?calibrate=1'), true);
  assert.equal(isCalibrationEnabled('?debug=1'), false);
  assert.equal(isCalibrationEnabled(''), false);
});

// ---------------------------------------------------------------- 标定锚点

test('clampAnchorValue：钳到 0..1 并保留 4 位小数', () => {
  assert.equal(clampAnchorValue(-0.5), 0);
  assert.equal(clampAnchorValue(1.7), 1);
  assert.equal(clampAnchorValue(0.123456), 0.1235);
  assert.equal(clampAnchorValue(Number.NaN), 0);
});

test('serializeAnchors：输出稳定 JSON 且坐标已归一化', () => {
  const text = serializeAnchors([
    { id: 'eyeLeft', u: -1, v: 2 },
    { id: 'tailRoot', u: 0.5, v: 0.5 },
  ]);
  const parsed = JSON.parse(text) as { version: number; coordinate: string; anchors: { id: string; u: number; v: number }[] };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.coordinate, 'normalized');
  assert.deepEqual(parsed.anchors[0], { id: 'eyeLeft', u: 0, v: 1 });
  assert.equal(parsed.anchors[1]?.u, 0.5);
  // 末尾换行，便于 git 以文本方式 diff
  assert.equal(text.endsWith('\n'), true);
});

test('CALIBRATION_ANCHOR_DEFAULTS / normalizeAnchor：默认锚点都归一化且 id 唯一', () => {
  const ids = new Set<string>();
  for (const anchor of CALIBRATION_ANCHOR_DEFAULTS) {
    const normalized = normalizeAnchor(anchor);
    assert.ok(normalized.u >= 0 && normalized.u <= 1, `${anchor.id}.u 越界`);
    assert.ok(normalized.v >= 0 && normalized.v <= 1, `${anchor.id}.v 越界`);
    assert.equal(ids.has(anchor.id), false, `锚点 id 重复: ${anchor.id}`);
    ids.add(anchor.id);
  }
  assert.equal(ids.size, 4, 'P1 只需要眼左/眼右/尾根/呆毛根 4 个锚点');
});

// ---------------------------------------------------------------- CSS 契约

test('CSS：呼吸/摇摆/光晕/呆毛/动作关键帧齐全', () => {
  for (const name of ['pet-breathe', 'pet-sway', 'pet-halo', 'pet-ahoge', 'pet-tap', 'pet-shake', 'pet-lift']) {
    assert.ok(CSS.includes(`@keyframes ${name}`), `缺少关键帧 ${name}`);
  }
});

test('CSS：呼吸不再用 1.014 的 scale（那是"糊"的来源）', () => {
  assert.equal(CSS.includes('scale(1.014)'), false, '旧的大幅缩放会把 1px 描边拉虚');
  assert.ok(CSS.includes('scale(1.004)'), '新呼吸只允许 1.004 的微量缩放');
});

test('CSS：debug UI 默认隐藏，只有 data-debug=1 才显示', () => {
  // M6-b 起调试元素是三个：徽章 / 提示行 / 状态面板（O1），必须共用同一条 display:none
  assert.ok(
    /\.pet-badge\s*,\s*\.pet-hint\s*,\s*\.pet-debugbar\s*\{\s*display:\s*none/.test(CSS),
    '调试元素必须有默认 display:none',
  );
  assert.ok(CSS.includes("#pet-root[data-debug='1'] .pet-badge"), '徽章必须由 data-debug 门控');
  assert.ok(CSS.includes("#pet-root[data-debug='1'] .pet-hint"), '提示行必须由 data-debug 门控');
  assert.ok(CSS.includes("#pet-root[data-debug='1'] .pet-debugbar"), '调试面板必须由 data-debug 门控');
});

test('CSS：常驻关闭按钮的样式已彻底移除（O3：关闭只走右键原生菜单）', () => {
  assert.equal(CSS.includes('.pet-close'), false, '窗口里不该再有任何关闭元素，连样式也不该留');
});

test('CSS：data-power=off 会暂停动画', () => {
  assert.ok(CSS.includes("#pet-root[data-power='off']"), '缺少 off 档规则');
  assert.ok(CSS.includes('animation-play-state: paused'), 'off 档必须暂停动画');
});

test('CSS：prefers-reduced-motion 关掉动态但保留眨眼', () => {
  const index = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(index > 0, '缺少 prefers-reduced-motion 分支');
  const block = CSS.slice(index);
  assert.ok(block.includes('.pet-halo'), '减少动效时必须关掉光晕');
  assert.ok(block.includes('.pet-ahoge'), '减少动效时必须关掉呆毛');
  assert.ok(block.includes("[data-motion] .pet-action"), '减少动效时必须关掉动作动画（宿主是 .pet-action，不是压平帧）');
  // 眨眼是状态切换（可用性信号），不该被这条媒体查询禁掉
  assert.equal(block.includes("data-expression='blink'"), false);
});

test('CSS：参数驱动档的变量名与 DRIVEN_CSS_VARIABLES 一一对应', () => {
  assert.deepEqual([...DRIVEN_PARAMS].sort(), Object.keys(DRIVEN_CSS_VARIABLES).sort());
  for (const param of DRIVEN_PARAMS) {
    const spec = DRIVEN_CSS_VARIABLES[param];
    assert.ok(spec.name.startsWith('--pet-'), `${param} 的变量名必须是 CSS 自定义属性`);
    assert.ok(CSS.includes(spec.name), `pet.css 缺少变量 ${spec.name}（seam S4 的落点）`);
  }
});

test('CSS：MOTION_DURATION_VARIABLES 全部被 CSS 使用', () => {
  for (const name of Object.values(MOTION_DURATION_VARIABLES)) {
    assert.ok(CSS.includes(name), `pet.css 未使用时长变量 ${name}`);
  }
});

// ------------------------------------------------- 节奏（偶发长停顿）与减少动态

test('节奏：一个周期 = 动的时长 + 可能的停顿，取值都落在区间内', () => {
  const active = nextMotionPace(seqRng([0, 0, 0]));
  assert.equal(active.activeMs, MOTION_ACTIVE_MIN_MS, 'rng=0 取动的下界');
  assert.equal(active.restMs, MOTION_REST_MIN_MS, '进入停顿时 rng=0 取下界');

  const long = nextMotionPace(seqRng([1, 0, 1]));
  assert.equal(long.activeMs, MOTION_ACTIVE_MAX_MS);
  assert.equal(long.restMs, MOTION_REST_MAX_MS);
});

test('节奏：不是每个周期都停顿（概率 60%，否则读成卡住）', () => {
  const skip = nextMotionPace(seqRng([0.5, MOTION_REST_PROBABILITY + 0.01, 0]));
  assert.equal(skip.restMs, 0, '超过概率阈值时本周期不停顿');
  const rest = nextMotionPace(seqRng([0.5, MOTION_REST_PROBABILITY - 0.01, 0.5]));
  assert.ok(rest.restMs >= MOTION_REST_MIN_MS, '进入停顿时必须给出正的停顿时长');
});

test('节奏：MotionPacer 按节奏在"动/歇"之间切换，stop 会复位', () => {
  const timer = new FakeTimer();
  const states: boolean[] = [];
  // 第一个周期：动 4200（rng=0）→ 停 1200（rng=0/0）
  const pacer = new MotionPacer((resting) => states.push(resting), seqRng([0, 0, 0, 1, 0, 0]), timer);
  pacer.start();
  assert.equal(pacer.isResting, false);
  timer.advance(MOTION_ACTIVE_MIN_MS);
  assert.equal(pacer.isResting, true);
  assert.deepEqual(states, [true]);
  timer.advance(MOTION_REST_MIN_MS);
  assert.equal(pacer.isResting, false);
  assert.deepEqual(states, [true, false]);
  pacer.stop();
  assert.equal(pacer.isRunning, false);
  assert.equal(timer.pending(), 0, 'stop 之后不许留下定时器');
});

test('节奏：stop 时若正处停顿时段，必须回调一次"恢复"避免动画永久冻结', () => {
  const timer = new FakeTimer();
  const states: boolean[] = [];
  const pacer = new MotionPacer((resting) => states.push(resting), seqRng([0, 0, 0]), timer);
  pacer.start();
  timer.advance(MOTION_ACTIVE_MIN_MS);
  assert.equal(pacer.isResting, true);
  pacer.stop();
  assert.equal(pacer.isResting, false);
  assert.deepEqual(states, [true, false]);
});

test('减弱动态：能识别 prefers-reduced-motion（matchMedia 注入）', () => {
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
  assert.equal(prefersReducedMotion(undefined), false, '宿主不支持时按"不减少"处理');
  assert.equal(
    prefersReducedMotion(() => {
      throw new Error('boom');
    }),
    false,
    '查询抛错不能把桌宠带崩',
  );
});

test('减弱动态：CSS 里必须存在对应的 @media 兜底', () => {
  assert.ok(CSS.includes('prefers-reduced-motion: reduce'), 'pet.css 缺少减少动态的媒体查询');
  assert.ok(CSS.includes(REDUCED_MOTION_QUERY), 'JS 与 CSS 的查询串必须一致');
});

test('CSS：存在"偶发停顿"的暂停规则，且与 MOTION_REST_ATTRIBUTE 对应', () => {
  assert.ok(CSS.includes(`[${MOTION_REST_ATTRIBUTE}='1']`), 'pet.css 缺少 data-motion-rest 暂停规则');
});

test('CSS：呼吸/摇摆关键帧是分段缓动 + 停顿（不是单条 sin）', () => {
  const breathe = CSS.slice(CSS.indexOf('@keyframes pet-breathe'), CSS.indexOf('@keyframes pet-sway'));
  // 分段缓动：关键帧各自带 animation-timing-function
  const easingCount = (breathe.match(/animation-timing-function/g) ?? []).length;
  assert.ok(easingCount >= 3, `呼吸关键帧应分段缓动（≥3 处），实际 ${easingCount}`);
  // 停顿：同一个 transform 值在相邻关键帧重复出现
  assert.ok(breathe.includes('38%') && breathe.includes('52%'), '呼吸应有屏息停顿段');
});

/**
 * 造一个按序列取值的 rng（用尽后重复最后一个值）。
 *
 * @param values 取值序列
 * @returns rng
 */
function seqRng(values: readonly number[]): () => number {
  let cursor = 0;
  return () => values[Math.min(cursor++, values.length - 1)] as number;
}
