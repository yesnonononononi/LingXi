/**
 * 姿态表现层控制器：`.pet-pose` 层的唯一主人。
 *
 * <p><b>它守的三条不变量（每条都有机器判据）：</b></p>
 * <ol>
 *   <li><b>单一可见源</b>（G-01）：`#pet-root[data-posture]` 由本类唯一写入；非站姿时
 *       `.pet-action` / `.pet-layers` 被 CSS 藏起来，站姿时 `.pet-pose` 被藏起来。
 *       互斥靠 CSS，不靠 JS 改样式 —— 于是"两套画面同时可见"在结构上不可能发生；</li>
 *   <li><b>层里恒有 1 个 `<img>`</b>（G-03）：换帧只改 `src`，绝不新建元素
 *       （新建 = 双影，且旧元素还在解码，会出现半透明的两层帧）；</li>
 *   <li><b>不叠脸层、不眨眼</b>（G-02）：进入非站姿姿态时停掉 `BlinkDriver`
 *       并让脸层/表情通道自然失效（层栈被 `display:none`），回到站姿再重启。</li>
 * </ol>
 *
 * <p><b>与 `LayeredPresentation` 是互斥关系，不是叠加</b>（裁决 D-A）：pose 帧是 3072²
 * 压平整帧，层栈坐标系是站姿母版 2048²，混进同一个 `plan` 会让 `z/rect/pivot` 全失真。
 * 所以本类**完全不碰**层栈，只写自己那一层。</p>
 *
 * <p><b>位置只许来自 `placement.ts` 的纯函数结果</b>（裁决 C6）：本类把
 * `left/top/width/height` 写到 `.pet-pose` 的 CSS 变量上，**绝不调用任何窗口 API**——
 * 切姿态不移动窗口，是"不跳脚"的根本保证。</p>
 *
 * @module pet/poses/controller
 */
import type { DocumentLike, ElementLike } from '../presentation/layered-presentation';
import { POSE_FRAME_ATTRIBUTE, POSE_LAYER_CLASS_NAME, POSTURE_ATTRIBUTE } from './css-contract';
import { batchOf, clipOf, frameOf, isPlayable } from './manifest';
import { PosePlayer, type PosePlayerPorts } from './player';
import type { Density, Facing, PetPoses, PoseBatch, PoseClip, PoseFrame, PostureId } from './types';

/** 站姿（`PostureId` 的成员；不写字面量散落各处）。 */
const STAND_POSTURE: PostureId = 'stand';

/** 姿态盒（CSS px）：`placement.ts` 的纯函数产物，本类只负责写进 DOM。 */
export interface PoseBox {
  /** 左（窗口坐标系，CSS px）。 */
  readonly left: number;
  /** 上（窗口坐标系，CSS px）。 */
  readonly top: number;
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 眨眼驱动的最小接口（`presentation/blink-driver.ts` 满足它，测试里用假的）。 */
export interface PoseBlinkLike {
  /** 停掉定时器。 */
  stop: () => void;
  /** 重新开始。 */
  start: () => void;
  /** 是否在跑。 */
  readonly isRunning: boolean;
}

/** 控制器依赖。 */
export interface PoseControllerOptions {
  /** 创建元素的文档。 */
  readonly doc: DocumentLike;
  /** `#pet-root`：`data-posture` 写这里。 */
  readonly root: ElementLike;
  /** `.pet-art`：`.pet-pose` 挂这里（与压平帧、层栈同级）。 */
  readonly host: ElementLike;
  /** 姿态清单（唯一真源）。 */
  readonly poses: PetPoses;
  /** 运行时密度（`1x` / `2x`）。 */
  readonly density: Density;
  /** 播放器端口（时钟与回调，由 `main.ts` 注入真实实现）。 */
  readonly ports: PosePlayerPorts;
  /** 姿态盒计算（`placement.ts`；不注入则只换图不定位，用于无布局的纯结构测试）。 */
  readonly boxOf?: ((batch: PoseBatch, frame: PoseFrame) => PoseBox | null) | null;
  /** 眨眼驱动（非站姿要停、回站姿要启）。 */
  readonly blink?: PoseBlinkLike | null;
  /** 日志。 */
  readonly log?: (message: string) => void;
  /**
   * 当前朝向（`-1` 左 / `1` 右），默认 `-1`。
   *
   * <p>为什么要有它：`walk`/`run` 的 `cycle` 会产出**同 id 两条片段**（左右各一条）。
   * 选片段必须按朝向定位，否则右向动作会静默拿到左向那一条（旧实现的 `find` 就是这个问题）。
   * 切片 1 的 `sit` 只有一条 `facing:-1` 的 `hold`，默认值即命中，行为与旧实现逐字节相同。</p>
   */
  readonly facing?: Facing;
}

/**
 * 姿态控制器。
 *
 * <p>生命周期：`main.ts` 在 `buildDom()` 之后构造一次，之后只调 `setPosture()` /
 * `pause()` / `resume()`。</p>
 */
export class PoseController {
  /** 依赖。 */
  private readonly options: PoseControllerOptions;

  /** 播放器。 */
  private readonly player: PosePlayer;

  /** `.pet-pose` 层元素（唯一）。 */
  private readonly layer: ElementLike;

  /** 层内唯一的那张 `<img>`。 */
  private readonly image: ElementLike;

  /** 当前姿态。 */
  private postureValue: PostureId = STAND_POSTURE;

  /** 当前片段（用于暂停/恢复与排障）。 */
  private clip: PoseClip | null = null;

  /** 当前帧 id（排障与断言用）。 */
  private frameIdValue: string | null = null;

  /** 已写过 placement 的帧 id（同一帧重复上屏时不重复写样式）。 */
  private placedFrameId: string | null = null;

  /** 当前朝向（选项缺省为 `-1`；非法值在构造时抛错，不在选片段时才发现）。 */
  private readonly facingValue: Facing;

  /**
   * 构造控制器：建 `.pet-pose` 与其中唯一的 `<img>`，并写入初始站姿。
   *
   * @param options 依赖
   */
  constructor(options: PoseControllerOptions) {
    this.options = options;
    const facing = options.facing ?? -1;
    if (facing !== -1 && facing !== 1) {
      throw new TypeError(`[pet-poses] PoseController 的 facing 只能是 -1 或 1，实际为 ${JSON.stringify(facing)}`);
    }
    this.facingValue = facing;
    const doc = options.doc;
    const layer = doc.createElement('div');
    layer.setAttribute('class', POSE_LAYER_CLASS_NAME);
    layer.setAttribute('aria-hidden', 'true');
    const image = doc.createElement('img');
    image.setAttribute(POSE_FRAME_ATTRIBUTE, '');
    image.setAttribute('alt', '');
    image.setAttribute('draggable', 'false');
    // 解码前保持不可见：先挂上去会出现"上半身到了、下半身没到"的闪动
    image.hidden = true;
    layer.appendChild(image);
    options.host.appendChild(layer);
    this.layer = layer;
    this.image = image;

    this.player = new PosePlayer({
      now: options.ports.now,
      schedule: options.ports.schedule,
      cancel: options.ports.cancel,
      onFrame: (frameId, index) => {
        this.handleFrame(frameId, index);
        options.ports.onFrame(frameId, index);
      },
      onClipEnd: (clipId) => {
        this.handleClipEnd(clipId);
        options.ports.onClipEnd(clipId);
      },
    });

    this.writePosture(STAND_POSTURE);
  }

  /** 当前姿态。 */
  get posture(): PostureId {
    return this.postureValue;
  }

  /** 当前帧 id（`null` = 没有在放姿态）。 */
  get currentFrameId(): string | null {
    return this.frameIdValue;
  }

  /** 姿态层里 `<img>` 的数量（G-03 的观测量；恒为 1）。 */
  get poseImageCount(): number {
    if (this.image === null || this.layer === null) return 0;
    const children = (this.layer as unknown as { children?: ArrayLike<unknown> }).children;
    if (children === undefined || children === null) return 1;
    let count = 0;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index] as { tagName?: string; getAttribute?: (name: string) => string | null };
      if (child && typeof child.tagName === 'string' && child.tagName.toLowerCase() === 'img') count += 1;
    }
    return count;
  }

  /** 姿态层元素（调试与断言用）。 */
  get layerElement(): ElementLike {
    return this.layer;
  }

  /** 姿态图元素（调试与断言用）。 */
  get imageElement(): ElementLike {
    return this.image;
  }

  /** 是否处于播放中。 */
  get isPlaying(): boolean {
    return this.player.isPlaying;
  }

  /**
   * 切姿态（唯一入口）。
   *
   * <p>姿态是**派生量**（`postureOf(state)` 的结果），本方法只负责让它上屏；
   * 任何地方都不许绕过状态机直接写 `posture` 字段。</p>
   *
   * @param next 目标姿态
   */
  setPosture(next: PostureId): void {
    if (next === this.postureValue) return;
    if (next === (STAND_POSTURE)) {
      this.leavePose('切回站姿');
      return;
    }
    if (!isPlayable(this.options.poses, next)) {
      // 优雅降级：没有资产（或资产不可播）就留在站姿，并说清楚为什么
      this.log(`姿态 ${next} 不可播（未登记 accepted 或缺帧），保持站姿`);
      this.leavePose(`姿态 ${next} 不可播`);
      return;
    }
    const batch = batchOf(this.options.poses, next);
    if (batch === null) {
      this.leavePose(`姿态 ${next} 没有批次`);
      return;
    }
    const clip = this.pickClip(batch);
    if (clip === null) {
      this.leavePose(`姿态 ${next} 没有可播片段`);
      return;
    }
    this.writePosture(next);
    this.postureValue = next;
    this.clip = clip;
    this.stopBlink();
    try {
      this.player.play(clip, 0);
    } catch (err) {
      // 时序非法属于构建期就该拦住的问题（G-13）；运行时只在日志里点名，画面回落站姿
      this.log(`姿态 ${next} 播放失败：${(err as Error).message}`);
      this.leavePose(`姿态 ${next} 播放失败`);
    }
  }

  /** 暂停当前片段（拖拽中途；姿态保持不变）。 */
  pause(): void {
    this.player.pause();
  }

  /** 恢复当前片段（拖拽松手）。 */
  resume(): void {
    this.player.resume();
  }

  /** 停止播放并回到站姿（销毁/降级用）。 */
  reset(): void {
    this.leavePose('reset');
  }

  /**
   * 收尾：停播放器、藏图、回站姿、重启眨眼。
   *
   * @param reason 原因（日志用）
   */
  private leavePose(reason: string): void {
    this.player.stop();
    this.clip = null;
    this.frameIdValue = null;
    this.placedFrameId = null;
    this.image.hidden = true;
    this.writePosture(STAND_POSTURE);
    this.postureValue = STAND_POSTURE;
    this.startBlink();
    this.log(`离开姿态：${reason}`);
  }

  /**
   * 选片段：按 `hold` / `cycle` / `once` / `enter` 顺序找**当前朝向**的片段。
   *
   * <p>与旧实现的差别只有一处、但是关键的一处：旧实现的 `clipOf` 是 `find(clip.id === id)`，
   * 在多朝向批次（`walk`/`run` 的 `cycle` 左右各一条）里会静默拿到左向那条。
   * 现在按 `(id, facing)` 双键定位；该朝向下四个 id 都没有片段就返回 null
   * （由调用方走"没有可播片段"的降级路径），**不再退回"取第一条"**——
   * 拿反朝向的片段上屏比不播更糟（角色会突然翻转）。</p>
   *
   * @param batch 批次
   * @returns 片段；没有当前朝向的可用片段时 null
   */
  private pickClip(batch: PoseBatch): PoseClip | null {
    for (const id of ['hold', 'cycle', 'once', 'enter']) {
      const clip = clipOf(batch, id, this.facingValue);
      if (clip !== null) return clip;
    }
    const available = batch.clips.map((clip) => `${clip.id}@${clip.facing}`).join('/');
    if (available.length > 0) {
      this.log(
        `姿态 ${batch.posture} 没有朝向 ${this.facingValue} 的片段（现有：${available}），不回落到其它朝向`,
      );
    }
    return null;
  }

  /**
   * 上屏一帧：只改 `src`（G-03），并把姿态盒写进 CSS 变量。
   *
   * @param frameId 帧 id
   * @param index 帧序号（日志与排障用）
   */
  private handleFrame(frameId: string, index: number): void {
    const batch = batchOf(this.options.poses, this.postureValue);
    if (batch === null) return;
    const frame = frameOf(batch, frameId);
    if (frame === null) {
      this.log(`姿态 ${this.postureValue} 的片段引用了不存在的帧 ${frameId}`);
      return;
    }
    const file = frame.files[this.options.density] ?? frame.files['1x'];
    this.image.src = file.url;
    this.image.hidden = false;
    this.frameIdValue = frameId;
    this.applyBox(batch, frame, index);
  }

  /**
   * 写姿态盒（只在换帧时写一次，避免每帧重复触发布局）。
   *
   * @param batch 批次
   * @param frame 帧
   * @param index 帧序号（日志用）
   */
  private applyBox(batch: PoseBatch, frame: PoseFrame, index: number): void {
    if (typeof this.options.boxOf !== 'function') return;
    if (this.placedFrameId === frame.id) return;
    const box = this.options.boxOf(batch, frame);
    if (box === null) {
      this.log(`姿态 ${this.postureValue} 第 ${index} 帧算不出姿态盒，保持上一帧位置`);
      return;
    }
    const style = (this.layer as unknown as { style?: { setProperty: (name: string, value: string) => void } }).style;
    if (style === undefined || typeof style.setProperty !== 'function') return;
    style.setProperty('left', `${box.left}px`);
    style.setProperty('top', `${box.top}px`);
    style.setProperty('width', `${box.width}px`);
    style.setProperty('height', `${box.height}px`);
    this.placedFrameId = frame.id;
  }

  /**
   * 一次性片段播完。
   *
   * @param clipId 片段 id
   */
  private handleClipEnd(clipId: string): void {
    const clip = this.clip;
    if (clip === null || clip.id !== clipId) return;
    if (clip.onEnd === 'return-stand') {
      this.leavePose(`片段 ${clipId} 播完（return-stand）`);
    }
  }

  /**
   * 写 `data-posture`（唯一写入点）。
   *
   * @param posture 姿态
   */
  private writePosture(posture: PostureId): void {
    this.options.root.setAttribute(POSTURE_ATTRIBUTE, posture);
  }

  /** 停眨眼（姿态态不眨眼：G-02）。 */
  private stopBlink(): void {
    const blink = this.options.blink;
    if (blink === null || blink === undefined) return;
    if (blink.isRunning) blink.stop();
  }

  /** 重启眨眼（回到站姿）。 */
  private startBlink(): void {
    const blink = this.options.blink;
    if (blink === null || blink === undefined) return;
    if (!blink.isRunning) blink.start();
  }

  /**
   * 写日志（缺省静默）。
   *
   * @param message 日志
   */
  private log(message: string): void {
    const log = this.options.log;
    if (typeof log === 'function') log(`[pet-pose] ${message}`);
  }
}
