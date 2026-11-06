/**
 * 姿态播放器：**纯逻辑**，不碰 DOM、不读时钟、不开定时器。
 *
 * <p><b>为什么必须写成纯逻辑：</b>姿态播放的 bug 几乎都是"时间相关"的——单帧姿态被当成
 * 0ms 循环导致 `requestAnimationFrame` 空转、暂停/恢复时把已经走过的时间又算一遍、
 * 跨朝向切批时相位跳回 0。这些都能靠"注入时钟 + 手动推进"在毫秒级精确复现；
 * 一旦内部直接调 `Date.now()` / `requestAnimationFrame`，测试就只能"睡一会儿再看"，
 * 边界（79 / 80 / 2400 / 2401）永远测不准。纪律与 `behavior/state-machine.ts` 完全一致。</p>
 *
 * <p><b>单帧静止姿态（`sit` 的 `hold`）的口径（D-03）：</b>`frames.length === 1` 且
 * `frameMs[0] === 0` 是**合法的可播放内容**——它画出一张静止姿态并停在那里。
 * 绝不允许为了"看起来像动画"给它加假帧，也不允许把它当成 0ms 循环（那是空转）。</p>
 *
 * @module pet/poses/player
 */
import type { PoseClip } from './types';

/**
 * 每帧时长的合法下界（毫秒）。
 *
 * <p>80ms ≈ 12.5fps。低于它人眼读成"跳帧"，而且 `frameMs: 0` 的多帧片段会让调度器
 * 立刻自我重排（rAF 空转，CPU 100%）。这是**守门值**，不许为了让某批跑起来放宽。</p>
 */
export const FRAME_MS_MIN = 80;

/** 每帧时长的合法上界（毫秒）。超过 2.4s 读成"卡住不动"（帧没坏，但表现像坏了）。 */
export const FRAME_MS_MAX = 2400;

/**
 * 帧时长的**窄豁免**（"动作开始前的静止等待"）——运行时侧。
 *
 * <p><b>为什么运行时也要这一条：</b>坐姿从切片 4 起不是单帧静姿，而是美术
 * `supplemental/gif-v1/manifest.json` 的 `clips.sit_blink`（7 帧 / 6.61 s）：
 * 第 0 帧 **2600 ms** 的语义是"坐定之后先静止 2.6 秒，然后眨两下眼"。把全局上限
 * {@link FRAME_MS_MAX} 抬高等于给所有片段开后门；把 2600 拆成两帧同图等于造假帧
 * （G-P14 正是防这个）。所以只开一条窄到只能用一次的豁免。</p>
 *
 * <p><b>单真源纪律（这条比豁免本身重要）：</b>构建门禁 `scripts/check-pet-poses.mjs` 里有
 * 同名同义的 `FRAME_MS_EXEMPTION`。跨语言 import 走不通（门禁是 node ESM，本文件被 vite 打包），
 * 所以按仓库既有先例做**文本对账**：门禁的 `checkPlayerExemptionDrift()` 会解析本文件，
 * 断言这里的四个数值与门禁侧逐值相等、且本函数真的引用了这四个字段——
 * **任一侧改动而另一侧未同步 ⇒ 门禁直接红**。（历史教训：同一条 2400 上限曾经有两份真源，
 * 结果是"门绿了运行时抛出 RangeError"，坐姿永远回站姿而门禁一条不红。）</p>
 *
 * <p><b>代理关系（已批准的口径）：</b>运行时拿不到 `contentId`（那是母版摘要，只在清单里），
 * 所以"真的在动"在这里降级为**片段内 distinct frame id ≥ 2**。真 `contentId` 判据（**G-P14**）
 * 由构建门禁独占把关，本函数只是运行时的下限守卫：它保证"长等待 + 同一张画"不会被放过去。
 * 门禁的对账判据会断言本文件确实写着这句代理关系（不许悄悄删掉注释后仍靠代码混过）。</p>
 */
export const FRAME_MS_EXEMPTION = Object.freeze({
  /** 超限帧自身的上限（ms）：再长就不像"入静"，像卡死。 */
  maxOverMs: 6000,
  /** 用了豁免的片段总时长上限（ms）。 */
  maxClipTotalMs: 9000,
  /** 只认片段第 0 帧（"动作开始前的静止等待"）。 */
  frameIndex: 0,
  /** 片段内 distinct frame id 的下限（= 门禁侧 distinct contentId 的运行时代理）。 */
  minDistinctFrames: 2,
});

/**
 * 判断某一帧能否走 {@link FRAME_MS_EXEMPTION}（只对"超过上限"的帧调用）。
 *
 * <p>五条同时成立才放行：第 0 帧 / 片段至少 {@link FRAME_MS_EXEMPTION.minDistinctFrames} 帧
 * （单帧片段天然被排除）/ 该帧 ≤ {@link FRAME_MS_EXEMPTION.maxOverMs} / 片段总时长
 * ≤ {@link FRAME_MS_EXEMPTION.maxClipTotalMs} / 片段内 distinct frame id ≥ 2。</p>
 *
 * @param frames 片段帧 id 列表
 * @param durations 片段逐帧时长（与 `frames` 等长）
 * @param index 当前帧序号
 * @returns 是否放行
 */
function frameMsExemptionApplies(
  frames: readonly string[],
  durations: readonly number[],
  index: number,
): boolean {
  if (index !== FRAME_MS_EXEMPTION.frameIndex) return false;
  if (frames.length < FRAME_MS_EXEMPTION.minDistinctFrames) return false;
  const ms = durations[index] ?? 0;
  if (!(ms <= FRAME_MS_EXEMPTION.maxOverMs)) return false;
  const total = durations.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  if (!(total <= FRAME_MS_EXEMPTION.maxClipTotalMs)) return false;
  return new Set(frames).size >= FRAME_MS_EXEMPTION.minDistinctFrames;
}

/** 单帧静止姿态的时长（`hold` 用 0 表示"不推进"，不是"立刻结束"）。 */
export const SINGLE_FRAME_HOLD_MS = 0;

/** 播放器对外部世界的全部依赖（时钟 + 帧回调）。 */
export interface PosePlayerPorts {
  /** 当前时刻（毫秒）。 */
  readonly now: () => number;
  /** 安排一次回调，返回句柄。 */
  readonly schedule: (callback: () => void, delayMs: number) => number;
  /** 取消一次回调。 */
  readonly cancel: (handle: number) => void;
  /** 上屏一帧（`frameId` 是该帧在批次里的 id，`index` 是它在 clip 里的序号）。 */
  readonly onFrame: (frameId: string, index: number) => void;
  /** 一次性片段播完（`onEnd: 'return-stand'` 的片段才会触发）。 */
  readonly onClipEnd: (clipId: string) => void;
}

/** 当前播放位置。 */
export interface PosePlayerPosition {
  /** 片段 id。 */
  readonly clipId: string;
  /** 帧序号（0 起）。 */
  readonly frameIndex: number;
  /** 帧 id。 */
  readonly frameId: string;
}

/**
 * 校验一个片段的时序是否合法（G-13 的纯函数形态）。
 *
 * <p>单帧静止姿态允许 `frameMs === [0]`；**除此之外任何 0 或越界值都是错的**：
 * 多帧片段里出现 0 ⇒ 调度器立刻重排（空转）；越界 ⇒ 人眼读成跳帧或卡死。</p>
 *
 * <p>同时校验 `facing`：片段朝向必须是 `-1` / `1`。播放器本身不按朝向取片段
 * （它只负责把**给定**片段按时序推上去），但它是最后一道"手里的片段是不是动物园"
 * 的检查点——构造出来的宽松对象（测试、调试面板）也走这里。</p>
 *
 * @param clip 片段
 * @returns 问题列表（空数组 = 合法）
 */
export function validatePoseClip(clip: PoseClip): string[] {
  const problems: string[] = [];
  if (clip.facing !== -1 && clip.facing !== 1) {
    problems.push(`片段 ${clip.id} 的 facing 必须是 -1 或 1，实际为 ${JSON.stringify(clip.facing)}`);
  }
  const frames = Array.isArray(clip.frames) ? clip.frames : [];
  const frameMs = Array.isArray(clip.frameMs) ? clip.frameMs : [];
  if (frames.length === 0) {
    problems.push(`片段 ${clip.id} 没有任何帧（空 clip 不是可播放内容）`);
    return problems;
  }
  if (frames.length !== frameMs.length) {
    problems.push(`片段 ${clip.id} 的 frames(${frames.length}) 与 frameMs(${frameMs.length}) 不等长`);
    return problems;
  }
  const singleHold = frames.length === 1;
  for (const [index, ms] of frameMs.entries()) {
    if (!Number.isFinite(ms)) {
      problems.push(`片段 ${clip.id} 第 ${index} 帧时长不是有限数值：${String(ms)}`);
      continue;
    }
    if (singleHold && ms === SINGLE_FRAME_HOLD_MS) continue;
    if (ms < FRAME_MS_MIN || ms > FRAME_MS_MAX) {
      // 窄豁免（与门禁 FRAME_MS_EXEMPTION 单真源对账，见该常量注释）：
      // 只放行"多帧片段第 0 帧的长等待"，且片段必须真的在动。低于下界永不豁免。
      if (ms > FRAME_MS_MAX && frameMsExemptionApplies(frames, frameMs, index)) continue;
      problems.push(
        `片段 ${clip.id} 第 ${index} 帧时长 ${ms}ms 不在 [${FRAME_MS_MIN}, ${FRAME_MS_MAX}]` +
          '（单帧静止姿态允许 0；多帧片段的 0 会让调度器空转）',
      );
    }
  }
  for (const [index, frameId] of frames.entries()) {
    if (typeof frameId !== 'string' || frameId.length === 0) {
      problems.push(`片段 ${clip.id} 第 ${index} 帧的 id 非法：${String(frameId)}`);
    }
  }
  return problems;
}

/**
 * 姿态播放器。
 *
 * <p>用法：`play(clip, startAtMs)` 之后由注入的 `schedule` 推进；`pause()` / `resume()`
 * 供拖拽使用；`seek(index)` 供"跨批切朝向时对齐相位"使用。</p>
 */
export class PosePlayer {
  /** 外部依赖。 */
  private readonly ports: PosePlayerPorts;

  /** 当前片段（`null` = 未播放）。 */
  private clip: PoseClip | null = null;

  /** 当前帧序号。 */
  private index = 0;

  /** 下一次推进的句柄（`null` = 没有排程：静止帧、已暂停或已播完）。 */
  private handle: number | null = null;

  /** 是否处于暂停（拖拽中途）。 */
  private paused = false;

  /** 当前帧开始显示的时刻。 */
  private frameStartedAt = 0;

  /** 当前帧还剩多少毫秒（暂停/恢复靠它，不许重算已流逝时间）。 */
  private remainingMs = 0;

  /**
   * 构造播放器。
   *
   * @param ports 时钟与回调
   */
  constructor(ports: PosePlayerPorts) {
    this.ports = ports;
  }

  /** 是否在播放（有片段且未停止）。 */
  get isPlaying(): boolean {
    return this.clip !== null;
  }

  /** 是否暂停。 */
  get isPaused(): boolean {
    return this.paused;
  }

  /** 当前播放位置（`null` = 未播放）。 */
  get current(): PosePlayerPosition | null {
    if (this.clip === null) return null;
    const frameId = this.clip.frames[this.index];
    if (frameId === undefined) return null;
    return { clipId: this.clip.id, frameIndex: this.index, frameId };
  }

  /**
   * 播放一个片段。
   *
   * @param clip 片段（时序不合法直接抛错，不静默放行）
   * @param startAtMs 起始时间轴位置（毫秒，相对片段起点；`0` = 从头播）
   * @throws {RangeError} 时序不合法
   */
  play(clip: PoseClip, startAtMs = 0): void {
    const problems = validatePoseClip(clip);
    if (problems.length > 0) {
      throw new RangeError(`[pet-poses] 无法播放：${problems.join('；')}`);
    }
    this.stopTimer();
    this.clip = clip;
    this.paused = false;
    this.index = this.indexAt(Math.max(0, Number.isFinite(startAtMs) ? startAtMs : 0));
    this.emitCurrentFrame();
  }

  /** 停止播放并清空位置。 */
  stop(): void {
    this.stopTimer();
    this.clip = null;
    this.index = 0;
    this.paused = false;
    this.remainingMs = 0;
    this.frameStartedAt = 0;
  }

  /** 暂停（拖拽开始）。已经暂停时不重复扣时间。 */
  pause(): void {
    if (this.clip === null || this.paused) return;
    const elapsed = this.ports.now() - this.frameStartedAt;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.stopTimer();
    this.paused = true;
  }

  /**
   * 恢复（拖拽结束）：按**剩余**时长继续，且**绝不推进帧、绝不上报收尾**。
   *
   * <p><b>为什么必须分三种情况（QA D-03 的根因）：</b>老实现在 `remainingMs <= 0` 时直接
   * `advance()`，于是"暂停期间剩余时间归零"与"自然播完"被当成同一件事。对单帧静止片段
   * （`frameMs = [0]`，`emitCurrentFrame` 把 `remainingMs` 置 0）来说，`pause → resume`
   * 就会走 `advance()` → 到末尾 → `onClipEnd('return-stand')` 被误触发：
   * 用户只是拖了一下宠物，姿态就提前结束了。暂停是**用户手势**，不是播放进度，
   * 让手势改变播放结果本身就是缺陷（`sit` 因为 `hold-last` 才侥幸无害）。</p>
   *
   * <p>三种情况：</p>
   * <ol>
   *   <li>当前帧时长 ≤ 0（静止帧，只会出现在单帧片段里）：恢复 = 原地不动，不排程、不推进；</li>
   *   <li>剩余 ≤ 0 但当前帧时长 > 0（整帧在暂停期间走完）：**从当前帧重开一个完整时长**，
   *       索引不变——宁可让这一帧多停一个 `frameMs`，也不让一次拖拽吃掉半帧；</li>
   *   <li>剩余 > 0：按剩余时长继续，不重算已流逝时间。</li>
   * </ol>
   */
  resume(): void {
    if (this.clip === null || !this.paused) return;
    this.paused = false;
    const frameMs = this.clip.frameMs[this.index] ?? 0;
    if (frameMs <= 0) {
      // 静止帧：本来就没有"待推进的时序"，恢复只能是原地不动
      this.remainingMs = frameMs;
      this.handle = null;
      return;
    }
    const remaining = this.remainingMs > 0 ? this.remainingMs : frameMs;
    this.remainingMs = remaining;
    this.frameStartedAt = this.ports.now();
    this.scheduleCurrentFrame(remaining);
  }

  /**
   * 跳到指定帧（跨批切朝向时对齐相位用）。
   *
   * @param frameIndex 帧序号（越界会被夹到合法范围）
   */
  seek(frameIndex: number): void {
    if (this.clip === null) return;
    const last = this.clip.frames.length - 1;
    const target = Math.min(last, Math.max(0, Math.floor(Number.isFinite(frameIndex) ? frameIndex : 0)));
    this.stopTimer();
    this.index = target;
    this.emitCurrentFrame();
  }

  /**
   * 按起始时间算出应落在第几帧。
   *
   * @param startAtMs 起始时间轴位置（毫秒）
   * @returns 帧序号
   */
  private indexAt(startAtMs: number): number {
    const clip = this.clip;
    if (clip === null) return 0;
    const total = clip.frameMs.reduce((sum, ms) => sum + (Number.isFinite(ms) ? ms : 0), 0);
    // 循环片段：把起点按周期取模（跨批对齐相位时就靠这里）；一次性片段：夹到末尾
    const offset = clip.loop && total > 0 ? (startAtMs % total) : Math.min(startAtMs, total);
    let acc = 0;
    for (let index = 0; index < clip.frames.length; index += 1) {
      const ms = clip.frameMs[index] ?? 0;
      if (offset < acc + ms || ms <= 0) return index;
      acc += ms;
    }
    return clip.frames.length - 1;
  }

  /** 上屏当前帧并按它的时长排下一次推进。 */
  private emitCurrentFrame(): void {
    const clip = this.clip;
    if (clip === null) return;
    const frameId = clip.frames[this.index];
    if (frameId === undefined) return;
    const ms = clip.frameMs[this.index] ?? 0;
    this.frameStartedAt = this.ports.now();
    this.remainingMs = ms;
    this.ports.onFrame(frameId, this.index);
    if (this.paused) return;
    this.scheduleCurrentFrame(ms);
  }

  /**
   * 排下一次推进。
   *
   * @param delayMs 延迟（`0` = 静止帧，**不排程**：排了就是空转）
   */
  private scheduleCurrentFrame(delayMs: number): void {
    if (delayMs <= 0) {
      this.handle = null;
      return;
    }
    this.handle = this.ports.schedule(() => {
      this.handle = null;
      this.advance();
    }, delayMs);
  }

  /** 推进到下一帧（到末尾时按 `loop` / `onEnd` 收尾）。 */
  private advance(): void {
    const clip = this.clip;
    if (clip === null || this.paused) return;
    const next = this.index + 1;
    if (next < clip.frames.length) {
      this.index = next;
      this.emitCurrentFrame();
      return;
    }
    if (clip.loop) {
      this.index = 0;
      this.emitCurrentFrame();
      return;
    }
    // 一次性片段播完：`hold-last` 停在末帧（静止姿态），`return-stand` 上报收尾
    this.handle = null;
    if (clip.onEnd === 'return-stand') {
      this.ports.onClipEnd(clip.id);
    }
  }

  /** 取消排程（幂等）。 */
  private stopTimer(): void {
    if (this.handle === null) return;
    this.ports.cancel(this.handle);
    this.handle = null;
  }
}
