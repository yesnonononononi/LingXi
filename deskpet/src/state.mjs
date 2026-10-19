// 桌宠状态机：只做纯逻辑，不碰 DOM / Electron，便于 node --test 直接验证。

/** 动作（决定播放哪套 CSS 动画）。 */
export const ACTION = Object.freeze({
  IDLE: 'idle',
  DRAG: 'drag',
  SLEEP: 'sleep',
});

/** 表情（决定展示哪一组脸部 SVG）。 */
export const FACE = Object.freeze({
  NORMAL: 'normal',
  HAPPY: 'happy',
  ANGRY: 'angry',
  SHY: 'shy',
  SLEEPY: 'sleepy',
  EXCITED: 'excited',
});

/** 多久没互动就趴下睡觉。 */
export const DEFAULT_SLEEP_AFTER_MS = 90_000;

/** 连点判定窗口：两次点击间隔超过它，连点计数清零。 */
export const DEFAULT_STREAK_WINDOW_MS = 1_200;

/** 连点到这个次数就翻脸（戳烦了）。 */
export const DEFAULT_ANGRY_AFTER_TAPS = 3;

/**
 * 桌宠状态机。
 * 约定：所有转换都由外部显式驱动（tap / dragStart / dragEnd / tick），
 * 这样时间相关行为在测试里可以用假的 now 完全确定，不需要 sleep。
 */
export class PetState {
  #now;
  #sleepAfterMs;
  #streakWindowMs;
  #angryAfterTaps;

  /** @type {string} */
  action = ACTION.IDLE;
  /** @type {string} */
  face = FACE.NORMAL;
  tapStreak = 0;

  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#sleepAfterMs = options.sleepAfterMs ?? DEFAULT_SLEEP_AFTER_MS;
    this.#streakWindowMs = options.streakWindowMs ?? DEFAULT_STREAK_WINDOW_MS;
    this.#angryAfterTaps = options.angryAfterTaps ?? DEFAULT_ANGRY_AFTER_TAPS;
    this.lastInteractAt = this.#now();
    this.lastTapAt = Number.NEGATIVE_INFINITY;
  }

  /** 当前状态快照，供渲染层直接消费。 */
  get snapshot() {
    return Object.freeze({
      action: this.action,
      face: this.face,
      tapStreak: this.tapStreak,
      sleeping: this.action === ACTION.SLEEP,
    });
  }

  /**
   * 被点了一下。
   * 睡觉时点击是「惊醒」，不累计连点，否则醒来第一下就翻脸太不讲道理。
   */
  tap() {
    const at = this.#now();
    this.lastInteractAt = at;

    if (this.action === ACTION.SLEEP) {
      this.action = ACTION.IDLE;
      this.face = FACE.EXCITED;
      this.tapStreak = 0;
      this.lastTapAt = at;
      return this.snapshot;
    }

    if (at - this.lastTapAt > this.#streakWindowMs) {
      this.tapStreak = 0;
    }
    this.tapStreak += 1;
    this.lastTapAt = at;

    this.action = ACTION.IDLE;
    this.face = this.tapStreak >= this.#angryAfterTaps ? FACE.ANGRY : FACE.HAPPY;
    return this.snapshot;
  }

  /** 开始被拎起来。 */
  dragStart() {
    this.action = ACTION.DRAG;
    this.face = FACE.SHY;
    this.tapStreak = 0;
    this.lastInteractAt = this.#now();
    return this.snapshot;
  }

  /** 放回桌面。 */
  dragEnd() {
    this.action = ACTION.IDLE;
    this.face = FACE.NORMAL;
    this.tapStreak = 0;
    this.lastInteractAt = this.#now();
    return this.snapshot;
  }

  /**
   * 心跳（建议 1s 一次）。
   * 职责只有两件事：久无互动去睡觉；表情在连点窗口结束后回落到常态。
   * 拖动中既不睡觉也不回落表情——被拎着的时候状态由用户的手决定。
   */
  tick() {
    const at = this.#now();

    if (this.action === ACTION.DRAG) {
      return this.snapshot;
    }
    if (this.action === ACTION.SLEEP) {
      this.face = FACE.SLEEPY;
      return this.snapshot;
    }
    if (at - this.lastInteractAt >= this.#sleepAfterMs) {
      this.action = ACTION.SLEEP;
      this.face = FACE.SLEEPY;
      this.tapStreak = 0;
      return this.snapshot;
    }
    if (this.face !== FACE.NORMAL && at - this.lastTapAt > this.#streakWindowMs) {
      this.face = FACE.NORMAL;
    }
    return this.snapshot;
  }
}
