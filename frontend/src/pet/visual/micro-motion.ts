/**
 * 微动态与视觉层门控（呼吸 / 摇摆 / 呆毛 / 光晕 / 功耗档位 / 调试可见性）。
 *
 * <p><b>本批的"活"感全落在这里，而且成本接近零：</b>四条 CSS 合成器动画 + 一条
 * `data-power` 属性。<b>不引入 rAF 主循环</b>——桌宠常驻，多一个每帧跑的主循环就是
 * 永久 CPU 税。</p>
 *
 * <p><b>为什么时长要用 JS 写变量而不是写死在 CSS：</b>`low` 档要"时长 ×2"做视觉降频。
 * 用变量可以让同一个数值在 CSS 与 JS 之间只有一份（`BASE_MOTION_TIMING`），
 * 测试也能直接断言乘数（`tests/petMicroMotion.test.ts`）。</p>
 *
 * @module pet/visual/micro-motion
 */
import { MOTION_RECIPES } from '../presentation/command-router';
import type { MotionId } from '../presentation/types';
import type { Power } from '../power-policy';

/** 基准时长（毫秒）：与 `pet.css` 里的静态默认值必须一致。 */
export const BASE_MOTION_TIMING = {
  /** 呼吸（与光晕同周期、相位锁定）。 */
  breathMs: 3600,
  /** 摇摆。 */
  swayMs: 5200,
  /** 呆毛（与身体反相）。 */
  ahogeMs: 2600,
} as const;

/** 各功耗档位的时长乘数（`low` 档 ×2 = 视觉降频）。 */
export const POWER_DURATION_MULTIPLIER: Readonly<Record<Power, number>> = {
  interactive: 1,
  idle: 1,
  low: 2,
  off: 1,
};

/** 写入 CSS 的时长变量名（与 `pet.css` 的 `var(--pet-*-ms)` 一一对应）。 */
export const MOTION_DURATION_VARIABLES = {
  breath: '--pet-breath-ms',
  sway: '--pet-sway-ms',
  ahoge: '--pet-ahoge-ms',
  motion: '--pet-motion-ms',
} as const;

/** 某个功耗档位下的动画时长组合。 */
export interface MotionTiming {
  /** 呼吸周期（毫秒）。 */
  readonly breathMs: number;
  /** 摇摆周期（毫秒）。 */
  readonly swayMs: number;
  /** 呆毛周期（毫秒）。 */
  readonly ahogeMs: number;
  /** 动画播放状态（`off` 档暂停）。 */
  readonly playState: 'running' | 'paused';
}

/**
 * 由功耗档位推导动画时长。
 *
 * @param power 功耗档位
 * @returns 时长组合（毫秒整数）
 */
export function motionTiming(power: Power): MotionTiming {
  const multiplier = POWER_DURATION_MULTIPLIER[power] ?? 1;
  return {
    breathMs: Math.round(BASE_MOTION_TIMING.breathMs * multiplier),
    swayMs: Math.round(BASE_MOTION_TIMING.swayMs * multiplier),
    ahogeMs: Math.round(BASE_MOTION_TIMING.ahogeMs * multiplier),
    playState: power === 'off' ? 'paused' : 'running',
  };
}

/**
 * 某个动作的动画时长（毫秒）。
 *
 * <p>直接取动作配方表里的时长，保证"表现层认为 tap 是 480ms"和"CSS 里 tap 动画跑 480ms"
 * 是同一个数字（否则手指离开时动画还在弹，读成 bug）。</p>
 *
 * @param motion 动作 id
 * @returns 时长（缺省动作没有时长时返回 480）
 */
export function motionAnimationMs(motion: MotionId): number {
  const recipe = MOTION_RECIPES[motion];
  const ms = recipe?.motionMs;
  return typeof ms === 'number' && ms > 0 ? ms : 480;
}

/**
 * 把功耗档位与时长写到宿主的 CSS 变量与 `data-power` 上。
 *
 * <p>写入面只有 CSS 自定义属性与 `data-*`（设计文档 §9.4 纪律 5）。</p>
 *
 * @param root `#pet-root`
 * @param power 功耗档位
 * @returns 本次写入的时长组合（便于调用方记录/测试）
 */
export function applyMicroMotion(root: HTMLElement, power: Power): MotionTiming {
  const timing = motionTiming(power);
  const style = root.style;
  style.setProperty(MOTION_DURATION_VARIABLES.breath, `${timing.breathMs}ms`);
  style.setProperty(MOTION_DURATION_VARIABLES.sway, `${timing.swayMs}ms`);
  style.setProperty(MOTION_DURATION_VARIABLES.ahoge, `${timing.ahogeMs}ms`);
  root.dataset.power = power;
  return timing;
}

/**
 * 写动作动画时长（切动作时调用一次）。
 *
 * @param root `#pet-root`
 * @param motion 动作 id
 * @returns 写入的毫秒数
 */
export function applyMotionDuration(root: HTMLElement, motion: MotionId): number {
  const ms = motionAnimationMs(motion);
  root.style.setProperty(MOTION_DURATION_VARIABLES.motion, `${ms}ms`);
  return ms;
}

/**
 * 是否开启调试 UI。
 *
 * <p><b>发布态必须隐藏</b>（用户明确要求别再露出调试标记）：只有 `?debug=1` 或开发态才开。
 * 这里做成纯函数是为了可测——判断写死在 `boot()` 里就只能靠人肉验证。</p>
 *
 * @param search `location.search`（含前导 `?`）
 * @param isDev 是否开发态（`import.meta.env.DEV`）
 * @returns 是否开启调试 UI
 */
export function isDebugEnabled(search: string, isDev: boolean): boolean {
  if (isDev === true) return true;
  return parseQueryFlag(search, 'debug');
}

/**
 * 解析查询串里的布尔开关（`?flag=1` 或 `?flag=true` 都算开）。
 *
 * @param search 查询串
 * @param name 参数名
 * @returns 是否开启
 */
export function parseQueryFlag(search: string, name: string): boolean {
  if (typeof search !== 'string' || search.length === 0) return false;
  const source = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(source);
  const value = params.get(name);
  if (value === null) return false;
  return value === '1' || value.toLowerCase() === 'true';
}
