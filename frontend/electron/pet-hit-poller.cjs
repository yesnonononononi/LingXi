/**
 * 命中轮询器（主进程的"命中真源"）。
 *
 * <p><b>它解决什么：</b>桌宠窗口默认 `setIgnoreMouseEvents(true)`（穿透），穿透期间窗口收不到
 * 点击，"鼠标进来了"这件事必须有**不依赖点击**的传感器。这里有两条通道：</p>
 * <ol>
 *   <li><b>主通道（即时）</b>：穿透态下 `{ forward: true }` 仍会把 `mousemove` 转发给渲染层，
 *       渲染层把它变成 `pet:hover-hint`，主进程收到就调 {@link HitPoller#poll} 当场采样 ——
 *       端到端一次 IPC 往返；</li>
 *   <li><b>安全网（定频）</b>：本模块的定时器按 `intervalMs` 采样，覆盖"没有 mousemove"的场景
 *       （被遮挡、绕进窗口、hint 通道失效）。</li>
 * </ol>
 *
 * <p><b>两条通道共用一个权威：</b>都以 `screen.getCursorScreenPoint()` 的读数为准，
 * hint 只决定"什么时候读"，不决定"读到什么"。所以伪造 hint 不会改变状态。</p>
 *
 * <p><b>为什么时钟与光标读取全部注入：</b>这样它在 node 里可以被"手摇"——测试用
 * `ManualClock` 推进时间、用假 `screen` 改 `cursor`，于是"进入 / 离开 / 抖动 / 隐藏停表"
 * 全部是确定性断言，没有 `await`、没有睡眠、不会 flake。</p>
 *
 * <p><b>有效命中 = 强制集合非空 ? true : 采样值。</b>用集合而不是布尔，是为了让
 * "拖拽中"与"右键菜单打开中"这两个例外互不覆盖（拖拽时弹菜单、菜单没关就去拖，
 * 布尔会被后一个 false 抹掉前一个 true）。</p>
 *
 * <p><b>省 CPU 的两条路径：</b>①强制期**不读光标**（拖拽时鼠标一定在宠物身上，
 * 读了也只是白花一次系统调用）；②挂起（窗口隐藏）时**停表**，一次都不采样。
 * 被隐藏的窗口里定时器照常跑（主进程显式关了 `backgroundThrottling`），
 * 所以停表必须发生在这里，不能指望渲染层的功耗档位。</p>
 *
 * @module electron/pet-hit-poller
 */

/** 内部使用的"私有"字段前缀（避免与公开方法重名）。 */
const NONE = null;

/**
 * 命中轮询器。
 *
 * <p>状态只有四个：`bounds`（窗口位置）、`inside`（滞回用上一拍）、`forced`（强制可交互原因）、
 * `suspended`（停表原因）。`sampled` 只是"最近一次采样结果"，不是权威。</p>
 */
class HitPoller {
  /**
   * @param {object} deps 依赖注入
   * @param {() => {x: number, y: number}} deps.getCursorPoint 读系统光标（`screen.getCursorScreenPoint`）
   * @param {(point: {x: number, y: number}, bounds: object, prevInside: boolean) => boolean} deps.testPoint
   *   命中判定（含滞回与矩形换算）；`bounds` 是本拍生效的窗口位置，`prevInside` 是上一拍结果
   * @param {(hit: boolean) => void} deps.onHitChange 有效命中**变化**时才回调
   * @param {number} deps.intervalMs 采样间隔（毫秒）
   * @param {{setInterval: Function, clearInterval: Function}} deps.clock 时钟（测试注入 ManualClock）
   */
  constructor(deps) {
    const options = deps && typeof deps === 'object' ? deps : {};
    if (typeof options.getCursorPoint !== 'function') {
      throw new TypeError('createHitPoller: deps.getCursorPoint 必须是函数');
    }
    if (typeof options.testPoint !== 'function') {
      throw new TypeError('createHitPoller: deps.testPoint 必须是函数');
    }
    if (typeof options.onHitChange !== 'function') {
      throw new TypeError('createHitPoller: deps.onHitChange 必须是函数');
    }
    const interval = Number(options.intervalMs);
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new RangeError(`createHitPoller: deps.intervalMs 必须是正数，实际为 ${String(options.intervalMs)}`);
    }
    const clock = options.clock;
    if (!clock || typeof clock.setInterval !== 'function' || typeof clock.clearInterval !== 'function') {
      throw new TypeError('createHitPoller: deps.clock 必须提供 setInterval / clearInterval');
    }

    /** @type {() => {x: number, y: number}} */
    this.readCursor = options.getCursorPoint;
    /** @type {(point: object, bounds: object, prevInside: boolean) => boolean} */
    this.testPoint = options.testPoint;
    /** @type {(hit: boolean) => void} */
    this.onHitChange = options.onHitChange;
    /** @type {number} */
    this.intervalMs = interval;
    /** @type {{setInterval: Function, clearInterval: Function}} */
    this.clock = clock;

    /** 当前窗口位置（窗口坐标 → 屏幕坐标的平移量）；null = 还没有窗口。 */
    this.bounds = NONE;
    /** 最近一次采样结果。 */
    this.sampled = false;
    /** 上一拍是否在内侧（滞回状态，跨采样保留）。 */
    this.inside = false;
    /** 上一次**对外宣告**的有效命中（去重基准）。 */
    this.emitted = false;
    /** 强制可交互的原因集合（`'drag'` / `'menu'`）。 */
    this.forcedReasons = new Set();
    /** 停表的原因集合（`'hidden'`）。 */
    this.suspendedReasons = new Set();
    /** 是否已 `start()`。 */
    this.started = false;
    /** 定时器句柄。 */
    this.timer = NONE;
    /** 实际采样次数（诊断 + 停表用例的判据）。 */
    this.samples = 0;
  }

  /**
   * 当前有效命中（`forced` 非空 ⇒ 恒 true）。
   *
   * @returns {boolean} 是否命中
   */
  get hit() {
    return this.forcedReasons.size > 0 ? true : this.sampled;
  }

  /** 是否处于停表状态（隐藏 / 功耗 off）。 */
  get suspended() {
    return this.suspendedReasons.size > 0;
  }

  /**
   * 窗口位置变化（移动 / 缩放 / 切屏 / 拖拽跟随）→ 更新平移量。
   *
   * <p>不立即采样：采样点由定时器或显式 `poll()` 决定，避免"移动一次就多判一次"。
   * 传 `null` 表示窗口没了，后续采样直接跳过。</p>
   *
   * @param {{x: number, y: number, width: number, height: number} | null} bounds 窗口几何
   * @returns {void}
   */
  setWindowBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') {
      this.bounds = NONE;
      return;
    }
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.bounds = NONE;
      return;
    }
    this.bounds = {
      x,
      y,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
    };
  }

  /**
   * 置/清一个"强制可交互"原因。
   *
   * <p>置上立即收敛（拖拽一开始就必须可交互，不能等下一拍）；清掉也立即收敛
   * （拖拽结束时光标可能已经在窗外，等一拍会让用户先看到 16ms 的可交互）。
   * 解除时读一次光标即可，不需要额外等待。</p>
   *
   * @param {string} reason 原因（`'drag'` / `'menu'`）
   * @param {boolean} on 置上还是清掉
   * @returns {void}
   */
  setForced(reason, on) {
    const key = String(reason || '');
    if (key === '') throw new TypeError('HitPoller.setForced: reason 不能为空');
    if (on === true) this.forcedReasons.add(key);
    else this.forcedReasons.delete(key);
    this.poll();
  }

  /**
   * 置/清一个"停表"原因。
   *
   * <p><b>停表时必须把状态收敛到"未命中"</b>（而不是只 `clearInterval`）：窗口一旦隐藏，
   * "可交互"就没有意义了，而且隐藏期间的鼠标位置与窗口不构成任何关系。若只停表不收敛，
   * 轮询器内部会留着 `hit=true`，下次 `show()` 采样得到同样的 true ⇒ 去重逻辑认为"没变化"
   * ⇒ 窗口永远停在隐藏前那一刻的穿透状态（实测症状：显示后仍然整窗可交互或整窗穿透）。
   * 顺便清掉强制原因：窗口都藏了，拖拽/菜单的存在前提已消失。</p>
   *
   * @param {string} reason 原因（`'hidden'`）
   * @param {boolean} on 停表还是恢复
   * @returns {void}
   */
  setSuspended(reason, on) {
    const key = String(reason || '');
    if (key === '') throw new TypeError('HitPoller.setSuspended: reason 不能为空');
    if (on === true) {
      this.suspendedReasons.add(key);
      this.stopTimer();
      this.forcedReasons.clear();
      this.sampled = false;
      this.inside = false;
      this.converge();
    } else {
      this.suspendedReasons.delete(key);
      if (this.started && !this.suspended) this.startTimer();
    }
  }

  /**
   * 立即采样一次并收敛。
   *
   * <p><b>刻意是同步且无定时器的：</b>它是 `pet:hover-hint` 的直接落点，"光标刚进立绘"到
   * `setIgnoreMouseEvents(false)` 之间不许出现任何 `setTimeout`/`setImmediate` —— 那正是
   * 30ms 合并窗口把首击吃掉的老路。</p>
   *
   * <p>停表期间**不读光标**（C15 的判据）；强制期间也不读（省一次系统调用）。
   * 两种情况都会把"有效命中"收敛到该有的值。</p>
   *
   * @returns {boolean} 采样后的有效命中
   */
  poll() {
    if (this.suspended || this.forcedReasons.size > 0 || this.bounds === NONE) {
      this.converge();
      return this.hit;
    }
    let point = NONE;
    try {
      point = this.readCursor();
    } catch {
      // 读光标失败不该弄崩主进程：保持上一拍结果，等下一次采样
      point = NONE;
    }
    if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) {
      this.samples += 1;
      this.inside = this.testPoint({ x: Number(point.x), y: Number(point.y) }, this.bounds, this.inside) === true;
      this.sampled = this.inside;
    }
    this.converge();
    return this.hit;
  }

  /** 开始计时（重复调用无副作用）。 */
  start() {
    if (this.started) return;
    this.started = true;
    if (!this.suspended) this.startTimer();
  }

  /** 停止计时（销毁窗口时调用；此后 `poll()` 仍可手动调用）。 */
  stop() {
    this.started = false;
    this.stopTimer();
  }

  /**
   * 把有效命中同步给消费者（值没变就什么都不做）。
   *
   * @returns {void}
   */
  converge() {
    const value = this.hit;
    if (value === this.emitted) return;
    this.emitted = value;
    this.onHitChange(value);
  }

  /** 起定时器（`unref` 掉：轮询器不该阻止进程退出）。 */
  startTimer() {
    if (this.timer !== NONE) return;
    this.timer = this.clock.setInterval(() => {
      this.poll();
    }, this.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 停定时器。 */
  stopTimer() {
    if (this.timer === NONE) return;
    this.clock.clearInterval(this.timer);
    this.timer = NONE;
  }
}

/**
 * 创建命中轮询器。
 *
 * @param {object} deps 见 {@link HitPoller} 构造函数
 * @returns {HitPoller} 轮询器
 */
function createHitPoller(deps) {
  return new HitPoller(deps);
}

module.exports = {
  createHitPoller,
  HitPoller,
};
