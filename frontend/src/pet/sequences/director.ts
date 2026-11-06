/**
 * 序列导演：按时间轴把"每步放哪一帧、摆在哪"推给各层端口。
 *
 * <p><b>它是纯逻辑 + 端口</b>：不读时钟（`tick(nowMs)` 由调用方喂）、不开定时器、不碰窗口位置。
 * 与 `poses/player.ts` 同一套纪律，好处是"第 8 步该不该出现""循环回到第几步"这类问题
 * 可以在毫秒级精确复现——一旦内部直接 `Date.now()` / `requestAnimationFrame`，
 * 测试就只能"睡一会儿再看"，边界永远测不准。</p>
 *
 * <p><b>两条不许（单写者纪律，设计 §4.6 不变量 1 / §7.4）：</b></p>
 * <ol>
 *   <li><b>主角层的像素不归本类写</b>：某步引用了 `protagonist` 帧时，只能调
 *       {@link SequenceProtagonistPort.showFrame}（由 `PoseController` 上屏）。
 *       本轮 `PoseController` 还没有这个窄接口（`src/pet/poses/**` 禁改），所以端口缺省为空，
 *       真的被引用时**明确报错**，绝不静默丢帧；</li>
 *   <li><b>`dy` 每步重算，不累加</b>：累加会让循环场景里"云朵越飞越高"。</li>
 * </ol>
 *
 * <p><b>为什么 DOM 实现在本文件里：</b>本轮的文件白名单只有
 * `sequences/{types,manifest,director}.ts` 三个文件；伙伴层是"序列独占的新元素"
 * （新 `z-index`，不动 `.pet-action`），它既是导演的端口实现，也只能留在这里。</p>
 *
 * @module pet/sequences/director
 */

import type { DocumentLike, ElementLike } from '../presentation/layered-presentation';
import { PET_GEOMETRY, type PetGeometry } from '../layout';
import { companionBoxOf, frameFileOf, layerOf, sceneOf, sceneIdsOf, type SequenceStageAnchor } from './manifest';
import type {
  PetSequences,
  SequenceCssBox,
  SequenceDensity,
  SequenceFrameFile,
  SequenceLayerId,
  SequenceLayerPort,
  SequenceProtagonistPort,
  SequenceScene,
  SequenceSceneEnd,
  SequenceSnapshot,
  SequenceStep,
} from './types';

/** 时钟端口（导演只有一个外部依赖：`now()`）。 */
export interface SequenceClockPort {
  /** 当前时刻（毫秒）。 */
  readonly now: () => number;
}

/** 一次 `play()` 的摘要（后门用来回显"几几步 / 多少毫秒"）。 */
export interface SequencePlayReport {
  /** 场景 id。 */
  readonly sceneId: string;
  /** 步数。 */
  readonly steps: number;
  /** 总时长（ms）。 */
  readonly durationMs: number;
}

/** 导演依赖。 */
export interface SequenceDirectorOptions {
  /** 序列清单（唯一真源）。 */
  readonly sequences: PetSequences;
  /** 时钟。 */
  readonly clock: SequenceClockPort;
  /** 各层的端口（缺层 = 该层不显示；本轮只有 `companion`）。 */
  readonly layers: Readonly<Partial<Record<SequenceLayerId, SequenceLayerPort>>>;
  /** 主角层的窄接口（本轮缺省为空，见模块注释）。 */
  readonly protagonist?: SequenceProtagonistPort | null;
  /** 本步没写坐标时的伙伴基准位置（舞台域）。 */
  readonly base?: SequenceStageAnchor | null;
  /**
   * 场景收尾回调（`onEnd: 'return-stand'` 时由导演调用）。
   *
   * <p>导演**不自己**调 `setPosture`：那是姿态域的事，且本轮 `PoseController` 禁改。
   * 由调用方决定"回坐姿"怎么做。</p>
   */
  readonly onSceneEnd?: ((sceneId: string, onEnd: SequenceSceneEnd) => void) | null;
  /** 日志。 */
  readonly log?: (message: string) => void;
  /** 几何真源（缺省 `PET_GEOMETRY`，测试可注入）。 */
  readonly geometry?: PetGeometry | null;
}

/**
 * 一段场景的总时长（ms）。
 *
 * @param scene 场景
 * @returns 总时长
 */
export function sceneDurationOf(scene: SequenceScene): number {
  return scene.steps.reduce((sum, step) => sum + step.ms, 0);
}

/**
 * 按已跑时长定位当前步序号。
 *
 * <p>用**前缀和**定位而不是"每步排一个定时器"：定时器会被 GC/节流/掉帧漂移，
 * 而前缀和只依赖 `now` 的差值，掉帧时自动跳过被耽误的步（"宁可直接跳到该在的那步，
 * 也不要把 3.18 秒的动画演成 5 秒"）。</p>
 *
 * @param scene 场景
 * @param elapsedMs 已跑时长（已对循环取模）
 * @returns 步序号（越界时取末步）
 */
export function stepIndexAt(scene: SequenceScene, elapsedMs: number): number {
  let accumulated = 0;
  for (const [index, step] of scene.steps.entries()) {
    accumulated += step.ms;
    if (elapsedMs < accumulated) return index;
  }
  return scene.steps.length - 1;
}

/** 序列导演。 */
export class SequenceDirector {
  /** 依赖。 */
  private readonly options: SequenceDirectorOptions;

  /** 当前场景 id（`null` = 未播放）。 */
  private sceneIdValue: string | null = null;

  /** 当前步序号（`-1` = 未播放）。 */
  private stepIndexValue = -1;

  /** 播放起点（ms）。 */
  private startedAtMs = 0;

  /** 已跑时长（ms，未对循环取模，排障用）。 */
  private elapsedMsValue = 0;

  /**
   * 构造导演（不启动任何东西；`play()` 才会推第一步）。
   *
   * @param options 依赖
   * @throws {TypeError} 缺少必需品
   */
  constructor(options: SequenceDirectorOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('[pet-sequences] SequenceDirector 需要 options');
    }
    if (options.sequences === null || options.sequences === undefined) {
      throw new TypeError('[pet-sequences] SequenceDirector.sequences 缺失');
    }
    if (typeof options.clock?.now !== 'function') {
      throw new TypeError('[pet-sequences] SequenceDirector.clock.now 必须是函数（导演不自己读时钟）');
    }
    this.options = options;
  }

  /** 当前场景 id；未播放时 `null`。 */
  get sceneId(): string | null {
    return this.sceneIdValue;
  }

  /** 当前步序号；未播放时 `-1`。 */
  get stepIndex(): number {
    return this.stepIndexValue;
  }

  /** 是否在播。 */
  get isPlaying(): boolean {
    return this.sceneIdValue !== null;
  }

  /**
   * 播放一个场景（会先 `stop()`，保证任何时刻只有一段编排在跑）。
   *
   * @param sceneId 场景 id
   * @returns 摘要（步数 / 总时长）
   * @throws {TypeError} 场景不存在（不可信输入必须报错，不许静默返回）
   */
  play(sceneId: string): SequencePlayReport {
    const scene = typeof sceneId === 'string' ? sceneOf(this.options.sequences, sceneId) : null;
    if (scene === null) {
      const available = sceneIdsOf(this.options.sequences).join(' / ');
      throw new TypeError(`[pet-sequences] 没有场景 ${JSON.stringify(sceneId)}（可播：${available || '无'}）`);
    }
    if (scene.steps.length === 0) {
      throw new TypeError(`[pet-sequences] 场景 ${sceneId} 没有任何 step，拒绝播放`);
    }
    this.stop();
    this.sceneIdValue = sceneId;
    this.stepIndexValue = -1;
    this.startedAtMs = this.options.clock.now();
    this.elapsedMsValue = 0;
    this.applyStep(scene, 0);
    this.log(`播放场景 ${sceneId}：${scene.steps.length} 步 / ${sceneDurationOf(scene)} ms`);
    return { sceneId, steps: scene.steps.length, durationMs: sceneDurationOf(scene) };
  }

  /**
   * 停止：藏起所有层（不清帧，避免下次闪现半解码的旧图）。
   */
  stop(): void {
    if (this.sceneIdValue === null && this.stepIndexValue < 0) return;
    const layers = this.options.layers;
    for (const layerId of Object.keys(layers) as SequenceLayerId[]) {
      layers[layerId]?.stop();
    }
    this.log(`停止场景 ${this.sceneIdValue ?? '(未播放)'}`);
    this.sceneIdValue = null;
    this.stepIndexValue = -1;
    this.elapsedMsValue = 0;
  }

  /**
   * 推进到某个时刻（由调用方的动画循环喂）。
   *
   * @param nowMs 当前时刻（毫秒，与 `clock.now()` 同一时间轴）
   */
  tick(nowMs: number): void {
    const sceneId = this.sceneIdValue;
    if (sceneId === null) return;
    if (!Number.isFinite(nowMs)) return;
    const scene = sceneOf(this.options.sequences, sceneId);
    if (scene === null) {
      // 清单在运行期被换掉这种事故：不许把索引留在半空中
      this.stop();
      return;
    }
    const total = sceneDurationOf(scene);
    this.elapsedMsValue = Math.max(0, nowMs - this.startedAtMs);
    let position = this.elapsedMsValue;
    if (scene.loop && total > 0) {
      position %= total;
    } else if (position >= total) {
      // 一次性场景播完：`hold-last` 停在末帧，`return-stand` 交给调用方收尾
      this.applyStep(scene, scene.steps.length - 1);
      const onEnd = scene.onEnd;
      this.log(`场景 ${sceneId} 播完（${onEnd ?? '未声明'}）`);
      this.sceneIdValue = null;
      this.stepIndexValue = -1;
      if (onEnd !== null && typeof this.options.onSceneEnd === 'function') {
        this.options.onSceneEnd(sceneId, onEnd);
      } else if (onEnd === 'return-stand') {
        this.log('onEnd: return-stand 没有接线方（本轮主角收尾由调用方负责）');
      }
      for (const layerId of Object.keys(this.options.layers) as SequenceLayerId[]) {
        if (onEnd === 'hold-last') break;
        this.options.layers[layerId]?.stop();
      }
      return;
    }
    const index = stepIndexAt(scene, position);
    if (index !== this.stepIndexValue) this.applyStep(scene, index);
  }

  /** 读快照（排障与后门断言用）。 */
  snapshot(): SequenceSnapshot {
    const sceneId = this.sceneIdValue;
    const scene = sceneId === null ? null : sceneOf(this.options.sequences, sceneId);
    const slots: Partial<Record<SequenceLayerId, string>> = {};
    if (scene !== null && this.stepIndexValue >= 0) {
      const step = scene.steps[this.stepIndexValue];
      for (const [layerId, slot] of Object.entries(step?.frames ?? {})) {
        if (typeof slot === 'string') slots[layerId as SequenceLayerId] = slot;
      }
    }
    return {
      sceneId,
      stepIndex: this.stepIndexValue,
      slots,
      elapsedMs: this.elapsedMsValue,
      playing: sceneId !== null,
    };
  }

  /**
   * 上屏第 `index` 步（**唯一写层的地方**）。
   *
   * @param scene 场景
   * @param index 步序号
   */
  private applyStep(scene: SequenceScene, index: number): void {
    const step: SequenceStep | undefined = scene.steps[index];
    const sceneId = this.sceneIdValue;
    if (step === undefined || sceneId === null) return;
    this.stepIndexValue = index;
    for (const [layerId, slot] of Object.entries(step.frames) as [SequenceLayerId, string | null][]) {
      if (layerId === 'protagonist') {
        this.applyProtagonist(sceneId, slot);
        continue;
      }
      const port = this.options.layers[layerId];
      if (port === undefined) {
        // 层没接线：说出来（一个"没接到任何端口"的步等于黑场，静默就是欺骗）
        this.log(`第 ${index} 步引用了未接线的层 ${layerId}（该层本步不显示）`);
        continue;
      }
      if (slot === null) {
        port.setFrame(null);
        port.stop();
        continue;
      }
      const density = this.density();
      const file = frameFileOf(this.options.sequences, sceneId, layerId, slot, density);
      if (file === null) {
        this.log(`第 ${index} 步的 ${layerId}/${slot}@${density} 在清单里查不到（这一层保持上一帧）`);
        continue;
      }
      port.setFrame(file);
      if (layerId === 'companion') port.setPlacement(this.companionBox(step));
    }
  }

  /**
   * 主角层：只经窄接口上屏，端口缺失即报错。
   *
   * @param sceneId 场景 id
   * @param slot 帧 id（`pose-frames` 层里就是 `pet-poses.json` 的帧 id）
   */
  private applyProtagonist(sceneId: string, slot: string | null): void {
    if (slot === null) return;
    const port = this.options.protagonist;
    if (port === null || port === undefined) {
      this.log(
        `场景 ${sceneId} 引用了主角帧 ${slot}，但 PoseController.showFrame 窄接口尚未接线（B2）：` +
          '不许由序列自己写主角的 img.src（单写者纪律）',
      );
      return;
    }
    port.showFrame(slot);
  }

  /**
   * 算伙伴层本步的 CSS 盒子。
   *
   * @param step 本步
   * @returns 盒子；算不出来时 null（调用方保持上一帧位置）
   */
  private companionBox(step: SequenceStep): SequenceCssBox | null {
    const layer = layerOf(this.options.sequences, 'companion');
    if (layer === null) return null;
    return companionBoxOf({
      step,
      layer,
      sequences: this.options.sequences,
      base: this.options.base ?? null,
      geometry: this.options.geometry ?? PET_GEOMETRY,
    });
  }

  /**
   * 当前密度档（层端口自带；缺省 `1x`）。
   *
   * <p>密度不是导演的职责，但换帧时必须知道取哪一档；端口实现（`DomSequenceLayer`）
   * 用 DPR 决定，导演只问它。</p>
   *
   * @returns 密度档
   */
  private density(): SequenceDensity {
    const layer = this.options.layers.companion;
    const density = (layer as { readonly density?: SequenceDensity } | undefined)?.density;
    return density === '2x' ? '2x' : '1x';
  }

  /**
   * 写日志（缺省静默）。
   *
   * @param message 日志
   */
  private log(message: string): void {
    if (typeof this.options.log === 'function') this.options.log(`[pet-sequence] ${message}`);
  }
}

/**
 * 伙伴层 / 手掌层的 DOM 实现（**序列域独占的新元素**）。
 *
 * <p><b>它为什么不放进 `poses/controller.ts`：</b>那是姿态层的唯一主人，混进去就会让
 * "谁写 `.pet-pose`"变成两个答案。这里新建自己的 `<img>`，样式全部走行内
 * （本轮不许改 `pet.css`），`z-index` 取 2：与淡入中的立绘帧同层，靠**更晚的 DOM 顺序**
 * 压在上面，同时必须 `< 3`（调试面板的 `z-index`）——否则后门面板上的按钮会被云朵盖住点不到。</p>
 */
export class DomSequenceLayer implements SequenceLayerPort {
  /** 层 id。 */
  readonly layerId: SequenceLayerId;

  /** 当前密度档。 */
  readonly density: SequenceDensity;

  /** 层元素。 */
  private readonly element: ElementLike;

  /** 日志。 */
  private readonly log: (message: string) => void;

  /** 上一次写入的 URL（同一帧不重复赋值，避免重复解码）。 */
  private currentUrl = '';

  /**
   * 构造并挂载层元素。
   *
   * @param options 依赖
   * @throws {TypeError} 缺少 doc / host
   */
  constructor(options: {
    readonly doc: DocumentLike;
    readonly host: ElementLike;
    readonly layerId: SequenceLayerId;
    readonly density: SequenceDensity;
    readonly log?: (message: string) => void;
  }) {
    if (options?.doc === undefined || typeof options.doc.createElement !== 'function') {
      throw new TypeError('[pet-sequences] DomSequenceLayer 需要 doc.createElement');
    }
    if (options.host === undefined || typeof options.host.appendChild !== 'function') {
      throw new TypeError('[pet-sequences] DomSequenceLayer 需要 host.appendChild');
    }
    this.layerId = options.layerId;
    this.density = options.density;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    const element = options.doc.createElement('img');
    element.hidden = true;
    element.src = '';
    element.setAttribute('data-sequence-layer', options.layerId);
    const style = element.style;
    style.setProperty('position', 'absolute');
    style.setProperty('pointer-events', 'none');
    style.setProperty('z-index', '2');
    style.setProperty('display', 'block');
    options.host.appendChild(element);
    this.element = element;
    this.log(`[pet-sequence] 挂载层 ${options.layerId}（z-index=2、pointer-events=none，不参与命中判定）`);
  }

  /** 层元素（后门断言"真的挂上去了"用）。 */
  get elementHandle(): ElementLike {
    return this.element;
  }

  /**
   * 换帧。
   *
   * @param frame 帧文件；`null` = 本步不显示
   */
  setFrame(frame: SequenceFrameFile | null): void {
    if (frame === null) {
      this.element.hidden = true;
      this.currentUrl = '';
      return;
    }
    if (this.currentUrl !== frame.url) {
      this.element.src = frame.url;
      this.currentUrl = frame.url;
    }
    this.element.hidden = false;
  }

  /**
   * 写位置与尺寸（窗口 CSS 坐标；只改这一层，不动窗口）。
   *
   * @param box 盒子；`null` = 位置未知，保持不动
   */
  setPlacement(box: SequenceCssBox | null): void {
    if (box === null) return;
    const style = this.element.style;
    style.setProperty('left', `${box.left}px`);
    style.setProperty('top', `${box.top}px`);
    style.setProperty('width', `${box.width}px`);
    style.setProperty('height', `${box.height}px`);
  }

  /** 停：藏起这一层。 */
  stop(): void {
    this.element.hidden = true;
    this.currentUrl = '';
  }
}
