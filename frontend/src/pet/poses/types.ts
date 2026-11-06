/**
 * 桌宠姿态（pose）运行时的**类型契约**：唯一真源 `frontend/pet-poses.json` 的强类型视图。
 *
 * <p><b>为什么姿态不在 `presentation/types.ts` 的 `MotionId` 里：</b>动作（tap/angry/sleepy…）
 * 是"身体怎么抖"，走三层槽模型（base / transient / ambient，带优先级与 TTL）；姿态
 * （sit/lie/sleep/walk/run/jump）是"身体是什么形态"，**排他**——同一时刻只有一个身体。
 * 把姿态塞进 `MOTION_IDS` 会让 `pet-motions.json` 缺项、并让姿态进入槽模型的
 * "优先级 + TTL + 回落"语义，而姿态根本没有那套语义（设计文档 §A1.5.3）。</p>
 *
 * <p><b>三个域（本文件最重要的部分）：</b>母版（3072²/2048²）、native（1536²/1024²）、
 * CSS（窗口视口 = DIP）。历史事故：有人在 `native→CSS` 上用了 `S/2` 而不是 `S*2`，
 * 直接算成"run 只需 31 CSS px、完全装得下"。同类错误只能靠类型拦，所以三个域各是一个
 * brand 类型：互相赋值编译不过。跨域换算**只允许**经 {@link module:pet/poses/units}。</p>
 *
 * <p><b>`src/pet/poses/**` 里不许出现的东西</b>（`tests/petPoseManifest.test.ts` 有静态扫描）：
 * `0.15234375` / `0.076171875` 这类裸比例、`* 2` / `/ 2` 这类裸换算（唯一例外是
 * `units.ts` 的换算实现本身）。</p>
 *
 * @module pet/poses/types
 */

/**
 * 母版像素域（3072×3072 或 2048×3072）。
 *
 * <p>美术 manifest 里的 `bbox`、`anchor`、`canvas` 都在这个域。</p>
 */
export type MasterPx = number & { readonly __brand: 'MasterPx' };

/**
 * 原生像素域（1536×1536 或 1024×1536）。
 *
 * <p>`bodyAnchor`、`native.bbox`、`anchorNormalized` 的反算结果都在这个域。
 * 批级 `bodyAnchor` 用的是 native，**不是**母版——这是踩过的坑（四倍偏差）。</p>
 */
export type NativePx = number & { readonly __brand: 'NativePx' };

/**
 * 窗口视口域（CSS px ＝ Electron DIP，与 `MouseEvent.clientX` 同一空间）。
 *
 * <p>DPR **不参与**换算：DPR 只决定挑 `@1x` 还是 `@2x` 的图片文件（窗口尺寸单位是 DIP）。</p>
 */
export type CssPx = number & { readonly __brand: 'CssPx' };

/**
 * 姿态 id。**不是** `MotionId`。
 *
 * <p>`stand` 是站姿（既有分层件/压平帧那一套），其余六个来自美术 `poses/<batch>/`。</p>
 */
export type PostureId = 'stand' | 'sit' | 'lie' | 'sleep' | 'walk' | 'run' | 'jump';

/** 全部姿态 id（真源在这里，测试与生成器共用同一份）。 */
export const POSTURE_IDS: readonly PostureId[] = ['stand', 'sit', 'lie', 'sleep', 'walk', 'run', 'jump'];

/** 需要美术资产的姿态（不含 `stand`）。 */
export type PosePostureId = Exclude<PostureId, 'stand'>;

/** 需要美术资产的姿态 id 列表。 */
export const POSE_POSTURE_IDS: readonly PosePostureId[] = ['sit', 'lie', 'sleep', 'walk', 'run', 'jump'];

/** 密度档（与既有 `layers/<id>@<density>.webp` 完全同名同序）。 */
export type Density = '1x' | '2x';

/**
 * 姿态态下**显式交付的降级**（"没做"和"做坏了"必须是两句不同的话）。
 *
 * <ul>
 *   <li>`no-face-overlay`：pose 帧是压平整帧，姿态态不叠 `face` 贴片（必然错位 = 穿模）；</li>
 *   <li>`no-blink`：姿态态不眨眼（脸层被隐藏，眨眼没有落点）。</li>
 * </ul>
 */
export type PoseDegradation = 'no-face-overlay' | 'no-blink';

/**
 * 比例契约：**必须与几何真源自洽**（`manifest.ts` 在加载时断言）。
 *
 * <p>`masterToCss === artWidth / canvasWidth`（1e-9）是 C2 那条等式：
 * `234/3072 = 156/2048 = 0.076171875` 逐位相等，所以换姿时角色大小恒定。
 * 任何"为了塞进窗口而缩放 pose"的改动都会被这条断言拒掉。</p>
 */
export interface PoseScale {
  /** 母版 → CSS（0.076171875）。 */
  readonly masterToCss: number;
  /** native → CSS（0.15234375 = masterToCss × 2）。 */
  readonly nativeToCss: number;
  /** 站姿立绘箱宽（156，来自 `frontend/pet-geometry.json`）。 */
  readonly artWidth: number;
  /** 站姿母版画布宽（2048，来自 `frontend/pet-geometry.json`）。 */
  readonly canvasWidth: number;
}

/** 站姿对齐点：pose 的 `bodyAnchor` 要落在窗口的这个 CSS 坐标上。 */
export interface AlignContract {
  /** 站姿躯干质心（native）。实测 `v3/front-standing.png` = 479.70。 */
  readonly xNative: NativePx;
  /** 站姿接地线（native）。= 母版 `anchor.y` 的一半 = 1454。 */
  readonly yNative: NativePx;
  /** 取证：`measured-blue-skirt-centroid` = 实测；降级必须可见。 */
  readonly xSource: 'measured-blue-skirt-centroid' | 'fallback-canvas-center';
}

/** 一个朝向的锚点（native）。 */
export interface FacingAnchor {
  /** 躯干质心 x（native）。 */
  readonly x: NativePx;
  /** 地面参考线 y（native）；**不跟帧底走**。 */
  readonly y: NativePx;
}

/** 批级锚点：按朝向声明，`byFacingSource` 说明它是怎么来的。 */
export interface BodyAnchor {
  /** 每个朝向一份；键是 `'-1'` / `'1'`（JSON 键只能是字符串）。 */
  readonly byFacing: Readonly<Record<'-1' | '1', FacingAnchor>>;
  /** `measured-per-facing` 实测 / `batch-single` 批级单值 / `mirror-derived` 画布镜像推导。 */
  readonly byFacingSource: 'measured-per-facing' | 'batch-single' | 'mirror-derived';
  /**
   * 美术自报的**批内锚点离散度**（native，逐帧实测与批级值的最大差；多朝向批取各朝向最大值）。
   *
   * <p>为什么要收下它：G-08 的判据"同批同 facing 帧锚点与批级锚点差 ≤ 2 native"没法在运行时重算
   * ——逐帧实测值只在美术 `manifest.json` 的 `bodyAnchor.measuredNativeTorsoX` 文本里。
   * 丢掉这个汇总值，G-08 就退化成恒等式（自造锚点 ⇒ 差恒为 0 ⇒ 永远绿）。</p>
   *
   * <p>`null` = 美术未报（v1 单帧批的合法形态），**不是 0**。</p>
   */
  readonly spreadNative?: NativePx | null;
  /** 美术自报的最大单帧偏差（native）；与 {@link spreadNative} 同源，任一超限即失败。 */
  readonly maxDeviationNative?: NativePx | null;
}

/** 批级包络（相对对齐点，CSS px）。不破边判据直接读它。 */
export interface EnvelopeCss {
  /** 最左（负值 = 在对齐点左侧）。 */
  readonly left: CssPx;
  /** 最右。 */
  readonly right: CssPx;
  /** 最上（负值 = 在对齐点上方）。 */
  readonly top: CssPx;
  /** 最下。 */
  readonly bottom: CssPx;
}

/** 朝向：`-1` 左、`1` 右。帧与片段都必须显式声明，缺省值不存在（见各字段注释）。 */
export type Facing = -1 | 1;

/** 一段可播内容。 */
export interface PoseClip {
  /** `hold` | `cycle` | `enter` | `idle` | `exit` … */
  readonly id: string;
  /**
   * 该片段所属朝向。
   *
   * <p><b>为什么必须有这个字段：</b>`pet-poses.json` 里 adapter
   * （`scripts/pet-pose-adapters.mjs` 的 `buildClips`）从切片 1 起就按朝向拆片段——
   * `walk`/`run` 的 `cycle` 会产出**同 id 两条 clip**，一条 `facing:-1`、一条 `facing:1`。
   * 旧类型不带 `facing`，`normalizeClip` 也就不读它，于是"生产者写入 → 类型与归一化器丢弃"，
   * 信息当场蒸发：取用时只能"取第一条"，右向永远拿不到（而且没人报错）。
   * 这属数据完整性 bug，不是未来功能——所以它是**必填**字段，
   * 缺失/`0`/`"1"` 一律由 `normalizeClip` 抛 `TypeError`，绝不默认成 `-1`
   * （默认值会让"漏写"和"左向"不可区分）。</p>
   */
  readonly facing: Facing;
  /** `PoseFrame` id 顺序（必须都属于本片段朝向）。 */
  readonly frames: readonly string[];
  /** 循环（true）还是一次性（false）。 */
  readonly loop: boolean;
  /** 与 `frames` 等长；**工程侧拥有**（美术 manifest 里 0 个时序字段）。 */
  readonly frameMs: readonly number[];
  /** 一次性片段的收尾动作。 */
  readonly onEnd?: 'hold-last' | 'return-stand';
}

/** 一张图片（某一密度档）。 */
export interface PoseAssetFile {
  /** 相对 `lxa://pet-poses/` 的上一级路径，如 `poses/sit/sit_neutral@2x.webp`。 */
  readonly file: string;
  /** 可直接给 `<img src>` 的 URL，如 `lxa://pet-poses/sit/sit_neutral@2x.webp`。 */
  readonly url: string;
  /** 像素宽。 */
  readonly width: number;
  /** 像素高。 */
  readonly height: number;
  /** 字节数。 */
  readonly bytes: number;
  /** 小写十六进制 sha256。 */
  readonly sha256: string;
  /** 编码格式。 */
  readonly format: 'webp' | 'webp-lossless';
  /**
   * 内容寻址标识：母版 PNG 的 `sha256` 前 16 位小写十六进制（`/^[0-9a-f]{16}$/`）。
   *
   * <p><b>它的语义是"同一张画"：</b>同一 `contentId` 的两帧像素完全相同，构建期只写一份
   * webp，两个帧位的 `file` / `url` 指向同一个磁盘文件。同 `contentId` 的引用必须
   * `bytes` / `sha256` / `format` 全等（G-P10 判据）。</p>
   *
   * <p><b>为什么是可选：</b>老清单（T01 之前生成物、单测里的最小 fixture）没有这个键，
   * 加载期把它当"没有内容寻址信息"而不是缺陷；一旦出现就必须是 16 位小写十六进制，
   * 否则 `normalizeAssetFile` 直接抛 `TypeError`（与 `sha256` 的严格度同口径）。</p>
   */
  readonly contentId?: string;
}

/** 一帧（两档密度各一份文件）。 */
export interface PoseFrame {
  /** 运行时帧 id（如 `sit_neutral`、`walk_l1`）。 */
  readonly id: string;
  /** 朝向：`-1` 左 / `1` 右。 */
  readonly facing: Facing;
  /** 两档密度。 */
  readonly files: { readonly '1x': PoseAssetFile; readonly '2x': PoseAssetFile };
  /** 接地参考（native，逐帧实名）。与批级 `bodyAnchor` 的一致性由 G-08 断言（≤2 native）。 */
  readonly anchorNative: FacingAnchor;
  /** 墨迹包围盒（native）。包络、不穿模、命中都用它。 */
  readonly inkNative: {
    readonly left: NativePx;
    readonly top: NativePx;
    readonly right: NativePx;
    readonly bottom: NativePx;
  };
  /** 腾空帧离地量（native）；落地/支撑帧为 `null`（= 0 语义，但"没这个词"与"等于 0"要能区分）。 */
  readonly airborneGapNative: NativePx | null;
  /** 仅取证，不参与渲染：支撑脚中心 x（native）。 */
  readonly supportFootX: NativePx | null;
}

/** 溯源：用了哪个 adapter、源 manifest 的 sha256、消费了哪些字段。 */
export interface PoseProvenance {
  /** 三种 manifest 形态各一个显式 adapter。 */
  readonly adapter: 'legacy-v1' | 'files-sequences-v2' | 'frames-nested-v3';
  /** 源 `manifest.json` 的 sha256（漂移检测的锚）。 */
  readonly manifestSha256: string;
  /** 被 adapter 消费的字段路径（白名单，用于字段漂移检测）。 */
  readonly consumedKeys: readonly string[];
  /** 被 `aliases` 解析掉的源文件名（省体积的证据）。 */
  readonly aliasesResolved: readonly string[];
}

/** 一个姿态批次。 */
export interface PoseBatch {
  /** 姿态 id。 */
  readonly posture: PostureId;
  /** 美术声明的资产 id（原样透传）。 */
  readonly assetId: string;
  /** 美术声明，原样透传，**不驱动任何行为**（可播性只看 `accepted[]`）。 */
  readonly status: 'awaiting-static-review' | 'approved' | 'frozen';
  /** 母版 / native 的倍率（1 或 2）。不许由调用点猜。 */
  readonly masterScale: number;
  /** 母版画布（母版域）。 */
  readonly canvas: { readonly width: MasterPx; readonly height: MasterPx };
  /** 原生画布（native 域）。 */
  readonly nativeCanvas: { readonly width: NativePx; readonly height: NativePx };
  /**
   * 本批的运行锚（native）。
   *
   * <p><b>引擎做对齐只许读这里</b>；批级/帧级的 `anchor`（母版域、画布基准）
   * 在 `PoseBatch` 上**根本不存在**——见 {@link PoseBatch} 的类型：想混用也拿不到。</p>
   */
  readonly bodyAnchor: BodyAnchor;
  /** 批级包络（相对对齐点，CSS px）。 */
  readonly envelopeCss: EnvelopeCss;
  /** 可播片段（一批可以有多个，如 `lie` 的 down/neutral/up）。 */
  readonly clips: readonly PoseClip[];
  /** 帧表（键 = 帧 id）。 */
  readonly frames: Readonly<Record<string, PoseFrame>>;
  /** 溯源。 */
  readonly provenance: PoseProvenance;
}

/** 未进入运行时的批次（切片 2 起是 `lie` / `sleep`；它们属切片 3）。 */
export interface PoseDeferredBatch {
  /** 姿态 id。 */
  readonly posture: PosePostureId;
  /** 中文原因（必须能直接贴进验收记录）。 */
  readonly reason: string;
}

/** 完整清单（生成物，勿手改——手改会被 `gate:pet:poses` 冲掉）。 */
export interface PetPoses {
  /** schema 版本。 */
  readonly version: 1;
  /** 生成脚本标识。 */
  readonly generatedBy: string;
  /** 美术源根（排障用，**引擎不读**）。 */
  readonly sourceRoot: string;
  /** 比例契约。 */
  readonly scale: PoseScale;
  /** 站姿对齐点。 */
  readonly align: AlignContract;
  /** 导出过的密度档。 */
  readonly densities: readonly Density[];
  /**
   * 已进入运行时的批次。
   *
   * <p><b>与设计稿的差异（已记录）：</b>设计稿写的是 `Record<PostureId, PoseBatch>`，
   * 但同一条注释又要求"缺批 = 该姿态无资产"。两者不能同时成立，这里取 `Partial`：
   * 缺的批次**键不存在**（`batchOf` 返回 null），而不是给一个字段空一半的对象。
   * 这样"没资产"与"资产坏了"在类型与运行时都不可能混淆。</p>
   */
  readonly batches: Readonly<Partial<Record<PostureId, PoseBatch>>>;
  /** 工程侧可播清单（`playable` 的唯一来源；改它必须改 `ACCEPTED_BATCHES`）。 */
  readonly accepted: readonly PostureId[];
  /** 未进入运行时的批次与原因（降级必须可见）。 */
  readonly deferred: readonly PoseDeferredBatch[];
  /** 姿态态的显式降级清单。 */
  readonly degradations: readonly PoseDegradation[];
  /** 合计（帧数与字节数）。 */
  readonly totals: {
    readonly frames: number;
    readonly bytes1x: number;
    readonly bytes2x: number;
  };
}
