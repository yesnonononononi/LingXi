/**
 * 桌宠序列（sequence）运行时的**类型契约**：唯一真源 `frontend/pet-sequences.json` 的强类型视图。
 *
 * <p><b>为什么"序列"不是"姿态"：</b>姿态是"身体是什么形态"（`PostureId`，排他，一批一批的逐帧像素）；
 * 序列是"<b>最多三个层按时间轴各演各的</b>"（主角帧 + 伙伴 + 手掌），它没有 `posture`、
 * 不进 `MOTION_IDS`、也不该往 `POSTURE_IDS` 里加一个 `play`（设计 §7.1 第四条：
 * `play_cloud` 的 15 步里主角全是坐姿帧 ⇒ play 是"坐着做一件事"的演出，不是姿态）。
 * 所以本文件与 `poses/types.ts` 是**并列**关系，不是继承关系。</p>
 *
 * <p><b>三个域的纪律同样适用，但域名不同：</b></p>
 * <ul>
 *   <li><b>舞台域（stage）</b>：1280×1536，主角 native 坐标系向右延伸出来、
 *       为了容下右侧的伙伴。`step.companionCenterX` / `companionFootY` / `companionDy` 都在这个域；</li>
 *   <li><b>母版域（source）</b>：伙伴母版 512×512。`layer.anchor` / `layer.grip` 在这个域
 *       （`gripStageY` 公式里的 `k = canvas.width / sourceCanvas.width` 就是这两域之比）；</li>
 *   <li><b>CSS 域</b>：窗口视口。换算只许经 `manifest.ts` 的 `stageToCssOf` / `companionBoxOf`。</li>
 * </ul>
 *
 * <p><b>B2 的形态：</b>`cloud_react`（伙伴单层）+ `play_cloud`（主角 / 伙伴 / 手掌三层）。
 * `play_cloud` 的三层都是 `sequence-frames`：它的主角帧（`sit_welcome` / `sit_hug` / 坐姿中性）
 * 是**演出帧**，不属于任何姿态片段——塞进 `pet-poses.json` 会触发 G-P4 孤儿帧判据，
 * 唯一"绕过"办法是编一条永不选中的片段（拿数据撒谎）。`pose-frames` 这条 kind 仍然保留：
 * 将来若有场景要借用真正的姿态帧，`PoseController.showFrame` 就是它的窄接口。</p>
 *
 * @module pet/sequences/types
 */

/** 层 id（`protagonist` 层的像素来自 `pet-poses.json`，本层只存帧 id）。 */
export type SequenceLayerId = 'protagonist' | 'companion' | 'hands';

/** 层 id 全集（真源在这里，门禁与测试共用同一份）。 */
export const SEQUENCE_LAYER_IDS: readonly SequenceLayerId[] = ['protagonist', 'companion', 'hands'];

/**
 * 层的帧来源。
 *
 * <ul>
 *   <li>`pose-frames`：主角层。**只存帧 id**，像素来自 `pet-poses.json`，
 *       上屏只能经 `PoseController.showFrame`（见 {@link SequenceProtagonistPort}）；</li>
 *   <li>`sequence-frames`：伙伴 / 手掌层。像素来自 `public/live2d/pet-sequences/**`。</li>
 * </ul>
 */
export type SequenceLayerKind = 'pose-frames' | 'sequence-frames';

/** 密度档（与 pose 同名同序）。 */
export type SequenceDensity = '1x' | '2x';

/** 密度档全集。 */
export const SEQUENCE_DENSITIES: readonly SequenceDensity[] = ['1x', '2x'];

/** 场景收尾语义（`null` = 循环场景，永远没有"播完"）。 */
export type SequenceSceneEnd = 'return-stand' | 'hold-last';

/** 舞台域比例契约（`stageToCss` 与 pose 的 `nativeToCss` 同值：同一舞台坐标系）。 */
export interface SequenceScale {
  /** 舞台单位 → CSS px（0.15234375）。 */
  readonly stageToCss: number;
}

/** 舞台尺寸（舞台域）。 */
export interface SequenceStage {
  /** 宽（1280：为了容下主角右侧的伙伴）。 */
  readonly width: number;
  /** 高（1536）。 */
  readonly height: number;
}

/** 一个矩形尺寸。 */
export interface SequenceSize {
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 一个点。 */
export interface SequencePoint {
  /** x。 */
  readonly x: number;
  /** y。 */
  readonly y: number;
}

/**
 * 一个层。
 *
 * <p><b>叠放序固定：`layers` 数组下标即 z 序</b>（0 最底），运行时**不许**重排
 * （设计 §7.4；美术 `placement.order` 就是它的真源）。</p>
 */
export interface SequenceLayer {
  /** 层 id。 */
  readonly id: SequenceLayerId;
  /** 帧来源。 */
  readonly kind: SequenceLayerKind;
  /**
   * 层盒子（**舞台域**）：伙伴 400×400。
   *
   * <p>注意它不是母版尺寸：目标像素 = `round(canvas.width × stageToCss × 密度)`，
   * 验算 `round(400 × 0.15234375 × 2) = 122`（设计 §7.6 实测值）。</p>
   */
  readonly canvas?: SequenceSize;
  /**
   * 母版画布（**母版域**）：伙伴 512×512。
   *
   * <p>`anchor` / `grip` 都在这个域里；`gripStageY` 的 `k` 由 `canvas / sourceCanvas` 得出。
   * 少了它只能靠"猜 512"算握持点。</p>
   */
  readonly sourceCanvas?: SequenceSize;
  /** 对齐锚（母版域）：伙伴是脚底中心 `(256, 470)`。 */
  readonly anchor?: SequencePoint;
  /** 握持点（母版域）：伙伴是 `(256, 333)`；B2 的"不脱手"判据读它。 */
  readonly grip?: SequencePoint;
}

/** 一个运行帧文件（键形如 `cloud_react/happy@2x.webp`）。 */
export interface SequenceFrameFile {
  /** 所属层（必须出现在 `layers` 里）。 */
  readonly layer: SequenceLayerId;
  /** 该层内的帧名（`neutral` / `happy`）。 */
  readonly slot: string;
  /** 目标像素宽（= `round(canvas.width × stageToCss × 密度)`）。 */
  readonly width: number;
  /** 目标像素高。 */
  readonly height: number;
  /** 字节数。 */
  readonly bytes: number;
  /** 母版 PNG 的 sha256（内容寻址的锚）。 */
  readonly sha256: string;
  /** 编码格式；`webp-lossless` 是**唯一允许**的值（有损会切掉边缘半透明）。 */
  readonly format: 'webp-lossless' | 'webp';
  /** 可直接给 `<img src>` 的 `lxa://` URL。 */
  readonly url: string;
}

/**
 * 编排的一步。
 *
 * <p><b>字段与设计草案的差异（B1 记录）：</b>草案的 `frames` 是
 * `Record<SequenceLayerId, string|null>`（三层全必填）。B1 只交付 companion 一层，
 * 若照抄就得给主角/手掌写 `null`，那等于声称"这一场景有主角层、本步不显示"——
 * 与"本场景根本没有主角层"是两件事。所以这里取 `Partial`，缺键 = 该层不参与本步。</p>
 */
export interface SequenceStep {
  /** 本步停留时长（ms），必须 > 0（0 会让调度器原地空转）。 */
  readonly ms: number;
  /** 逐层帧引用（值 = 该层的 slot 名）；`null` = 该层本步显式不显示。 */
  readonly frames: Readonly<Partial<Record<SequenceLayerId, string | null>>>;
  /** 伙伴在舞台坐标下的中心 x（B2 的 `play_cloud` 用；B1 缺省）。 */
  readonly companionCenterX?: number;
  /** 伙伴在舞台坐标下的脚底线 y（B2 用；B1 缺省）。 */
  readonly companionFootY?: number;
  /**
   * 伙伴的**逐帧垂直位移**（舞台域，负数向上）。
   *
   * <p>B1 的 `cloud_react` 只有这一种位移：`-14` 舞台 = `-2.13` CSS，就是"云朵轻跳"。
   * 草案没列这个字段，但 §7.7 的验收判据 ② 要求"dy 位移能动"，所以 B1 必须带上它。</p>
   */
  readonly companionDy?: number;
  /** 仅诊断用的阶段名（`approach` / `hug` / `end`…），**不进任何判据**。 */
  readonly phase?: string;
}

/** 一个场景（一段编排）。 */
export interface SequenceScene {
  /** 是否循环（循环场景的 `onEnd` 必须是 `null`）。 */
  readonly loop: boolean;
  /** 非循环场景的收尾语义；循环场景为 `null`。 */
  readonly onEnd: SequenceSceneEnd | null;
  /** 步骤（非空，时序单调）。 */
  readonly steps: readonly SequenceStep[];
}

/** 溯源：用了哪个 adapter、源 manifest 的 sha256、消费了哪些字段。 */
export interface SequenceProvenance {
  /** 生成它的适配器标识（`gif-v1-steps`）。 */
  readonly adapter: string;
  /** 美术源 `manifest.json` 的 sha256（漂移检测的锚）。 */
  readonly manifestSha256: string;
  /** 被适配器消费的字段路径（白名单，用于字段漂移检测）。 */
  readonly consumedKeys: readonly string[];
}

/** 未进入运行时的序列与原因（降级必须可见）。 */
export interface SequenceDeferredScene {
  /** 场景 id。 */
  readonly scene: string;
  /** 中文原因（必须能直接贴进验收记录）。 */
  readonly reason: string;
}

/**
 * 完整清单（生成物，勿手改——手改会被 `gate:pet:sequences` 冲掉）。
 *
 * <p>类型与 `frontend/pet-sequences.json` 一一对应；`frames` 的键是
 * `<scene>/<slot>@<density>.webp`（盘上相对路径），所以"清单里的键"与"盘的路径"
 * 在任何时候都只有一种说法。</p>
 */
export interface PetSequences {
  /** schema 版本。 */
  readonly version: 1;
  /** 生成脚本标识。 */
  readonly generatedBy: string;
  /** 美术源根（排障用，**引擎不读**）。 */
  readonly sourceRoot: string;
  /** 舞台比例契约。 */
  readonly scale: SequenceScale;
  /** 舞台尺寸。 */
  readonly stage: SequenceStage;
  /** 层表（下标即 z 序）。 */
  readonly layers: readonly SequenceLayer[];
  /** 场景表（键 = 场景 id）。 */
  readonly scenes: Readonly<Record<string, SequenceScene>>;
  /** 运行帧表（键 = 相对路径）。 */
  readonly frames: Readonly<Record<string, SequenceFrameFile>>;
  /** 合计（场景数 / 步数 / 字节数 / 总时长）。 */
  readonly totals: {
    readonly scenes: number;
    readonly steps: number;
    readonly bytes1x: number;
    readonly bytes2x: number;
    readonly durationMs: number;
  };
  /** 溯源。 */
  readonly provenance: SequenceProvenance;
  /** 未进入运行时的序列。 */
  readonly deferred: readonly SequenceDeferredScene[];
}

/**
 * 主角层的**窄接口**（`pose-frames` 层唯一的写入方式）。
 *
 * <p><b>单写者纪律（设计 §7.4）：</b>序列导演**不许**直接写主角的 `<img>.src`，
 * 只能调 `showFrame(frameId)`，由 `PoseController` 走同一条 `applyBox()`，
 * 于是"落点公式"只有一份 ⇒ 播完之后不会跳脚。</p>
 *
 * <p><b>B2 起它已经落地</b>（`PoseController.showFrame` / `clearSequenceFrame`）：
 * 序列期间 `posture` / `facing` **一个字都不改**，画面靠 `.pet-pose` 的行内
 * `display` 临时显形，收尾把行内样式撤掉即回到"由 `data-posture` 说了算"的常态。</p>
 */
export interface SequenceProtagonistPort {
  /**
   * 让主角显示某一帧（帧 id 来自 `pet-poses.json`）。
   *
   * @param frameId 姿态帧 id（如 `sit_welcome`）
   */
  showFrame: (frameId: string) => void;
  /**
   * 把序列临时借用过的画面**收干净**（可选；缺省时导演不调它）。
   *
   * <p>为什么需要它：`showFrame` 只负责"画上去"，而序列结束（或被 `stop()` 打断）时
   * 那一帧必须消失。收尾如果留给调用方，就会有人忘——忘掉的形态是"云走了，猫还保持着
   * 抱的姿势"（`PoseController` 的 `posture` 明明还是 `stand`，画面却停在抱姿）。</p>
   *
   * <p><b>它不许改姿态主状态</b>：`posture` / `facing` 的唯一主人仍是 `setPosture` /
   * `setFacing`，这条纪律对 `clear()` 同样成立（实现见 `PoseController.clearSequenceFrame`）。</p>
   */
  clear?: () => void;
}

/** 伙伴/手掌层的端口（DOM 实现在 `director.ts` 的 `DomSequenceLayer`）。 */
export interface SequenceLayerPort {
  /**
   * 换帧。
   *
   * @param frame 运行帧文件；`null` = 该层本步不显示
   */
  setFrame: (frame: SequenceFrameFile | null) => void;
  /**
   * 写位置（窗口 CSS 坐标）。
   *
   * @param box 位置与尺寸；`null` = 位置未知（保持不动）
   */
  setPlacement: (box: SequenceCssBox | null) => void;
  /**
   * 停：把该层**从视觉上撤掉**（不清 `src`，避免下次闪现半解码的旧帧）。
   *
   * <p><b>必须是幂等的</b>：连续调两次、以及"没 `setFrame()` 就调"都不许抛错、不许留可见
   * 残留。实现必须让"不可见"落到**行内 `display`**（只写 `hidden` 属性会被行内
   * `display: block` 打败，见 `DomSequenceLayer.setVisible`）。</p>
   */
  stop: () => void;
}

/** 一个层在窗口内的 CSS 盒子。 */
export interface SequenceCssBox {
  /** 左（CSS px）。 */
  readonly left: number;
  /** 上（CSS px）。 */
  readonly top: number;
  /** 宽（CSS px）。 */
  readonly width: number;
  /** 高（CSS px）。 */
  readonly height: number;
}

/** 导演对外暴露的快照（排障与后门断言用）。 */
export interface SequenceSnapshot {
  /** 当前场景 id；未播放时 `null`。 */
  readonly sceneId: string | null;
  /** 当前步序号（0 起）；未播放时 `-1`。 */
  readonly stepIndex: number;
  /** 当前步的 slot（各层）；未播放时为空对象。 */
  readonly slots: Readonly<Partial<Record<SequenceLayerId, string>>>;
  /** 已跑过的绝对时间（ms）；未播放时 0。 */
  readonly elapsedMs: number;
  /** 是否在播。 */
  readonly playing: boolean;
}

/**
 * 调试后门的序列通道（`petDebug.sequence.*`，**只在 DEV 构建里存在**）。
 *
 * <p>为什么定义在 `sequences/types.ts` 而不是 `debug/types.ts`：本批文件白名单不允许改
 * `debug/types.ts`（那是 pose 后门的契约文件）。这里只放**类型**，
 * 键名与挂载点仍由 `main.ts` 的 DEV 分支独占，B2 再把类型搬进 `debug/types.ts`。</p>
 */
export interface SequenceDebugHandle {
  /**
   * 播放一个场景。
   *
   * @param sceneId 场景 id（不可信输入：非法值抛错，不静默）
   * @returns 场景摘要（步数 / 总时长）
   */
  play: (sceneId: string) => { readonly sceneId: string; readonly steps: number; readonly durationMs: number };
  /** 停止播放并藏起所有序列层。 */
  stop: () => void;
  /** 读当前快照。 */
  snapshot: () => SequenceSnapshot;
  /** 全部可播场景 id。 */
  scenes: () => string[];
}
