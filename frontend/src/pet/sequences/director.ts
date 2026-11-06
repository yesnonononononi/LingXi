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
   * 停止：把所有层**从视觉上彻底撤掉**（不清帧，避免下次闪现半解码的旧图）。
   *
   * <p><b>幂等</b>：连续调两次、以及"没 `play()` 就 `stop()`"都必须安全——本方法只做
   * "撤层 + 复位三个字段"，没有一次性状态，重复进入的写入完全相同。</p>
   *
   * <p><b>为什么不再早退</b>：过去这里有 `if (sceneId === null && stepIndex < 0) return;`，
   * 而**自然播完的收尾路径**（`tick()` 里 `position >= total` 那段）也会把这两个字段复位成
   * `null` / `-1`——于是"播完之后再 `stop()`"会命中早退，层永远不会被撤。配合
   * `DomSequenceLayer` 只写 `hidden` 属性（被行内 `display:block` 打败，见该类的
   * {@link DomSequenceLayer.setVisible}），真机表现就是：`petDebug.sequence.stop()` 之后
   * 桌宠窗口上**一直留着一朵云**（`src` 还是停止前那一帧、`display` 仍是 `block`）。
   * 层的 `stop()` 自身幂等，所以无条件撤层不会带来多余副作用。</p>
   */
  stop(): void {
    const wasPlaying = this.sceneIdValue;
    this.hideAllLayers();
    if (wasPlaying !== null) this.log(`停止场景 ${wasPlaying}`);
    this.sceneIdValue = null;
    this.stepIndexValue = -1;
    this.elapsedMsValue = 0;
  }

  /**
   * 让所有已接线的层把画面撤掉（`stop()` 与场景自然收尾共用这一个出口）。
   *
   * <p>层没接线时跳过（缺层 = 该层本来就不显示，见 {@link SequenceDirectorOptions.layers}）。</p>
   */
  private hideAllLayers(): void {
    const layers = this.options.layers;
    for (const layerId of Object.keys(layers) as SequenceLayerId[]) {
      layers[layerId]?.stop();
    }
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
      // 收尾出口与 `stop()` 同源：`return-stand` 收完必须**真的看不见**（伙伴层的
      // `hidden` 属性会被行内 `display:block` 打败，见 DomSequenceLayer.setVisible）。
      // `hold-last` 是显式"停在末帧"语义，故意不撤层；它之后调 `stop()` 仍会撤
      // （`stop()` 的早退已删除，不会因为 sceneId 已复位就漏擦）。
      if (onEnd !== 'hold-last') this.hideAllLayers();
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
    element.src = '';
    element.setAttribute('data-sequence-layer', options.layerId);
    const style = element.style;
    style.setProperty('position', 'absolute');
    style.setProperty('pointer-events', 'none');
    style.setProperty('z-index', '2');
    options.host.appendChild(element);
    this.element = element;
    // 初始不可见：走同一个 setVisible（`hidden` + 行内 `display` 一起写），
    // 否则"构造时 display:block、之后只写 hidden"就是本批修的那个缺陷。
    this.setVisible(false);
    this.log(`[pet-sequence] 挂载层 ${options.layerId}（z-index=2、pointer-events=none，不参与命中判定）`);
  }

  /** 层元素（后门断言"真的挂上去了"用）。 */
  get elementHandle(): ElementLike {
    return this.element;
  }

  /**
   * 可见性的**唯一**写入口：行内 `display` 是权威，`hidden` 属性只是补齐语义。
   *
   * <p><b>为什么不能只写 `hidden`：</b>`hidden` 属性靠 UA 样式表
   * `[hidden] { display: none }` 生效，而**行内作者样式胜过 UA 样式表**。本层构造时
   * 写过 `display: block`（序列层要参与自身布局，不能用 `<img>` 的默认 inline 基线），
   * 所以只设 `hidden = true` 在真浏览器里是**静默失效**的：元素依旧 `display: block`
   * 挂在屏幕上、还挂着停止前那一帧的图。真机证据：`stop()` 之后 150 ms 读到
   * `{ src: 'neutral@1x.webp', display: 'block' }`，下一轮 `play()` 之前读到残留
   * `{ src: 'happy@1x.webp', display: 'block' }`。</p>
   *
   * <p><b>为什么选"`display: none`"而不是"移除节点"：</b>①`ElementLike` 的写入面
   * （`src` / `hidden` / `style` / `appendChild` / 属性读写）**没有 `remove()`**，
   * 移除节点必须扩 `presentation/layered-presentation.ts` 的类型——那是序列域之外的文件，
   * 本批禁改；②移除/重挂会让层在每次 `play()` 时重建一次，`elementHandle`（后门与诊断
   * 断言"真的挂上去了"的句柄）会变成指向旧节点，且重挂后 `position/z-index` 等行内样式
   * 都要重写一遍，多一条会漂移的生命周期；③`display` 翻转是**纯样式写入**，天然幂等，
   * 没有分配、没有重挂、没有解码失效（`src` 保留意味着下次 `play()` 不会闪现半解码的旧帧）。</p>
   *
   * @param visible 是否可见
   */
  private setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    this.element.style.setProperty('display', visible ? 'block' : 'none');
  }

  /**
   * 换帧。
   *
   * @param frame 帧文件；`null` = 本步不显示
   */
  setFrame(frame: SequenceFrameFile | null): void {
    if (frame === null) {
      this.currentUrl = '';
      this.setVisible(false);
      return;
    }
    if (this.currentUrl !== frame.url) {
      this.element.src = frame.url;
      this.currentUrl = frame.url;
    }
    this.setVisible(true);
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

  /**
   * 停：把这一层**从视觉上撤掉**（`display: none` + `hidden`）。
   *
   * <p><b>幂等</b>：连续调两次、以及"没 `setFrame()` 就 `stop()`"都不会抛错，也不会留下
   * 可见残留——本方法只写 `currentUrl` 与两个可见性字段，写完的状态与调一次完全相同。
   * 刻意**不清 `src`**：清掉会让下次 `play()` 的第一帧先闪一下半解码（同一张图重复解码），
   * 而"看不见"由 `display` 保证，不需要靠清图。</p>
   */
  stop(): void {
    this.currentUrl = '';
    this.setVisible(false);
  }
}
