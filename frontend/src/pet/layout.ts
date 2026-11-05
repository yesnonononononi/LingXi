/**
 * 桌宠布局纯函数：尺寸真源（`frontend/pet-geometry.json`）的唯一消费方。
 *
 * <p><b>为什么单独成模块：</b>窗口尺寸、立绘箱、命中矩形、归一化坐标以前散落在主进程常量、
 * CSS 变量、渲染层 `getBoundingClientRect()` 三处，靠注释指认一致性——注释不会在 CI 里失败。
 * 现在四者都由这里推导，且本模块**不碰 DOM、不碰 CSS**，可以在 node 里单测。</p>
 *
 * <p><b>坐标空间约定（全模块统一）：</b></p>
 * <ul>
 *   <li>窗口视口坐标：CSS px（＝Electron DIP），原点在宠物窗口左上角，与
 *       `MouseEvent.clientX/clientY` 同一空间。</li>
 *   <li>归一化坐标：`u ∈ [0,1]` 沿立绘画布宽度、`v ∈ [0,1]` 沿立绘画布高度，原点在画布左上角。
 *       方案B 的 Live2D 定位与 Cubism 顶点共用这套坐标。</li>
 * </ul>
 *
 * <p><b>立绘箱按画布 2:3 比例定，不按可见包围盒（0.729）定：</b>渲染一律等比 `contain`。
 * 箱子比例等于画布比例时 `contain` 恰好铺满；按可见包围盒定会得到横向留白，按更宽定就会裁掉尾巴
 * （v2 立绘右侧尾巴留白仅 5px）。</p>
 *
 * @module pet/layout
 */
import geometrySource from '../../pet-geometry.json';

/** 归一化矩形（相对立绘画布，0..1）。 */
export interface NormalizedRect {
  /** 左边界（含），0..1。 */
  readonly left: number;
  /** 上边界（含），0..1。 */
  readonly top: number;
  /** 右边界（含），0..1。 */
  readonly right: number;
  /** 下边界（含），0..1。 */
  readonly bottom: number;
}

/** 尺寸（CSS px）。 */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 点（窗口视口坐标，CSS px）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 矩形（窗口视口坐标，CSS px）。 */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 归一化坐标。 */
export interface UV {
  readonly u: number;
  readonly v: number;
}

/**
 * 特效安全边距（四边，CSS px）。
 *
 * <p><b>为什么从单值 `glowPad` 升级成四边：</b>四类溢出方向并不对称——呆毛弹动向上、
 * 光晕/阴影向下、气泡只占顶部、左右只需给耳根一点位移余量。单值只能取最大值，
 * 等于为了底部多花顶部空间。</p>
 *
 * <p><b>演进：</b>M3 先做等值迁移（四边都是 16，窗口仍是 188×338，行为逐字节不变）；
 * M4 拿到用户视觉批准后按设计文档 §1.8 定为 <b>上 24 / 右 20 / 下 18 / 左 20</b>，
 * 窗口随之变成 <b>196×348</b>。立绘箱仍是 156×234 —— 变的是特效留白，宠物本体一点没放大。</p>
 *
 * <p><b>M2 的 D-01 再改一次左右：</b>pose 批次（`walk/run/jump/lie/sleep`）的墨迹比立绘宽，
 * 左右各 20 装不下。实测 `run` 需要左侧 ≥ 48.95 CSS、右侧 ≥ 44.44 CSS，设计稿取 49 只剩
 * 0.049 px 余量（等于擦边），主理人裁决取 <b>左右各 56 ⇒ 窗口 268×348</b>。
 * 仍不动 `inkHeight` / `artWidth` / `artHeight`：宠物本体尺寸一点没变。</p>
 */
export interface EffectMargin {
  /** 上边（呆毛弹动需要）。 */
  readonly top: number;
  /** 右边（耳根位移需要）。 */
  readonly right: number;
  /** 下边（光晕/接地阴影需要）。 */
  readonly bottom: number;
  /** 左边（耳根位移需要）。 */
  readonly left: number;
}

/**
 * 桌宠几何（`frontend/pet-geometry.json` 的强类型视图）。
 *
 * <p>`inkHeight` 是**唯一的人工可调旋钮**；`artWidth/artHeight` 由
 * `scripts/build-pet-geometry.mjs` 回写，不由人手填。</p>
 */
export interface PetGeometry {
  /** 真源版本号（字段语义变化时自增）。 */
  readonly version: number;
  /** 立绘画布宽度（母版像素）。 */
  readonly canvasWidth: number;
  /** 立绘画布高度（母版像素）。 */
  readonly canvasHeight: number;
  /** 可见墨迹高度占画布高度的比例（来自 alpha 报告）。 */
  readonly visibleRatioY: number;
  /** 可见墨迹在画布内的归一化包围盒（来自 alpha 报告）。 */
  readonly visibleBounds: NormalizedRect;
  /** 角色可见高度（CSS px），唯一人工旋钮。 */
  readonly inkHeight: number;
  /** 立绘箱高度（CSS px，3 的倍数）。 */
  readonly artHeight: number;
  /** 立绘箱宽度（CSS px，= artHeight × 2 / 3）。 */
  readonly artWidth: number;
  /** 特效安全边距（四边，CSS px）。 */
  readonly effectMargin: EffectMargin;
  /** 兼容保留：老版本 JSON 没有 `effectMargin` 时四边取它。 */
  readonly glowPad: number;
  /** 顶部为气泡预留的高度（CSS px）。 */
  readonly bubbleHeight: number;
}

/** 画布宽高比 2:3。 */
export const ART_ASPECT = 2 / 3;

/**
 * 断言数值字段合法。
 *
 * @param value 原始值
 * @param name 字段名（报错用）
 * @param min 允许的最小值（含）
 * @param max 允许的最大值（含），省略表示不限
 * @returns 校验后的数值
 */
function requireNumber(value: unknown, name: string, min: number, max: number = Number.POSITIVE_INFINITY): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new TypeError(`[pet-geometry] 字段 ${name} 必须是有限数值，实际为 ${String(value)}`);
  }
  if (num < min || num > max) {
    throw new RangeError(`[pet-geometry] 字段 ${name} 必须落在 [${min}, ${max}]，实际为 ${num}`);
  }
  return num;
}

/**
 * 归一化特效边距：缺省时四边取 `glowPad`（向后兼容老版本真源）。
 *
 * <p>这是 M3 的**回退分支**，不是临时补丁：`pet-geometry.json` 是双仓共读的真源，
 * 老版本 JSON 没有 `effectMargin` 时不能让渲染层抛错——四边取 `glowPad` 正好等于旧行为。</p>
 *
 * @param raw 原始 `effectMargin` 值（可能是 undefined）
 * @param glowPad 兼容单值
 * @returns 四边边距（全部为非负有限数）
 */
export function resolveEffectMargin(raw: unknown, glowPad: number): EffectMargin {
  const fallback = requireNumber(glowPad, 'glowPad', 0);
  if (raw === undefined || raw === null) {
    return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  }
  if (typeof raw !== 'object') {
    throw new TypeError('[pet-geometry] effectMargin 必须是对象（四边数值）');
  }
  const record = raw as Record<string, unknown>;
  return {
    top: requireNumber(record.top, 'effectMargin.top', 0),
    right: requireNumber(record.right, 'effectMargin.right', 0),
    bottom: requireNumber(record.bottom, 'effectMargin.bottom', 0),
    left: requireNumber(record.left, 'effectMargin.left', 0),
  };
}

/**
 * 把 JSON 原文校验并转成强类型几何对象。
 *
 * <p>启动即校验而不是 `as PetGeometry` 硬转：真源被手改坏时，宁可这里抛一条点名报错，
 * 也不要让一个 `NaN` 一路流到 `setBounds` / 命中判定里变成"窗口消失"。</p>
 *
 * @param raw JSON 原文
 * @returns 校验后的几何对象
 * @throws TypeError / RangeError 字段非法时抛出
 */
export function normalizeGeometry(raw: unknown): PetGeometry {
  if (!raw || typeof raw !== 'object') throw new TypeError('[pet-geometry] 真源必须是对象');
  const source = raw as Record<string, unknown>;
  const bounds = source.visibleBounds;
  if (!bounds || typeof bounds !== 'object') throw new TypeError('[pet-geometry] 缺少 visibleBounds');
  const boundsRecord = bounds as Record<string, unknown>;

  const geometry: PetGeometry = {
    version: requireNumber(source.version, 'version', 1),
    canvasWidth: requireNumber(source.canvasWidth, 'canvasWidth', 1),
    canvasHeight: requireNumber(source.canvasHeight, 'canvasHeight', 1),
    visibleRatioY: requireNumber(source.visibleRatioY, 'visibleRatioY', 0.0001, 1),
    visibleBounds: {
      left: requireNumber(boundsRecord.left, 'visibleBounds.left', 0, 1),
      top: requireNumber(boundsRecord.top, 'visibleBounds.top', 0, 1),
      right: requireNumber(boundsRecord.right, 'visibleBounds.right', 0, 1),
      bottom: requireNumber(boundsRecord.bottom, 'visibleBounds.bottom', 0, 1),
    },
    inkHeight: requireNumber(source.inkHeight, 'inkHeight', 1),
    artHeight: requireNumber(source.artHeight, 'artHeight', 3),
    artWidth: requireNumber(source.artWidth, 'artWidth', 2),
    effectMargin: resolveEffectMargin(source.effectMargin, requireNumber(source.glowPad, 'glowPad', 0)),
    glowPad: requireNumber(source.glowPad, 'glowPad', 0),
    bubbleHeight: requireNumber(source.bubbleHeight, 'bubbleHeight', 0),
  };

  if (geometry.visibleBounds.right <= geometry.visibleBounds.left) {
    throw new RangeError('[pet-geometry] visibleBounds 必须满足 right > left');
  }
  if (geometry.visibleBounds.bottom <= geometry.visibleBounds.top) {
    throw new RangeError('[pet-geometry] visibleBounds 必须满足 bottom > top');
  }
  // 立绘箱必须严格 2:3，否则 contain 会出现横向留白或裁掉尾巴
  if (Math.abs(geometry.artWidth / geometry.artHeight - ART_ASPECT) > 0.0001) {
    throw new RangeError(
      `[pet-geometry] 立绘箱必须是 2:3，实际 artWidth/artHeight=${geometry.artWidth}/${geometry.artHeight}`,
    );
  }
  return geometry;
}

/** 运行时几何单例：由 `frontend/pet-geometry.json` 校验而来。 */
export const PET_GEOMETRY: PetGeometry = normalizeGeometry(geometrySource);

/**
 * 立绘箱在窗口内的原点（CSS px，含顶部气泡预留）。
 *
 * <p>派生链只有这一处：`左 = margin.left`、`上 = margin.top + bubbleHeight`。
 * 命中矩形、归一化坐标换算、气泡布局全部经 {@link ART_ORIGIN} 自动跟随。</p>
 *
 * @param g 几何
 * @returns 原点（立绘箱左上角）
 */
export function ART_ORIGIN(g: PetGeometry = PET_GEOMETRY): Point {
  return { x: g.effectMargin.left, y: g.effectMargin.top + g.bubbleHeight };
}

/**
 * 窗口尺寸 = 立绘箱 + 四边特效边距 + 顶部气泡。
 *
 * <p>四边必须分开加，不能写成 `glowPad × 2`：一旦边距不对称（M4 的 24/20/18/20），
 * 单值算法会让窗口比立绘箱窄/宽，`contain` 立刻出现留白或被窗口边缘裁切。</p>
 *
 * @param g 几何
 * @returns 窗口尺寸（CSS px ＝ DIP）
 */
export function windowSize(g: PetGeometry = PET_GEOMETRY): Size {
  const margin = g.effectMargin;
  return {
    width: g.artWidth + margin.left + margin.right,
    height: g.artHeight + margin.top + margin.bottom + g.bubbleHeight,
  };
}

/**
 * 立绘箱在窗口视口内的矩形。
 *
 * @param g 几何
 * @returns 立绘箱矩形
 */
export function artBox(g: PetGeometry = PET_GEOMETRY): Box {
  const origin = ART_ORIGIN(g);
  return { x: origin.x, y: origin.y, width: g.artWidth, height: g.artHeight };
}

/**
 * 可见包围盒换算成窗口视口内的命中矩形。
 *
 * <p>命中的基准是**可见墨迹**而不是整个立绘箱：整箱比墨迹宽 3.5px、高 24.7px，
 * 用整箱会让用户"点在透明区也算命中"，桌面上表现为点不动其他窗口。</p>
 *
 * @param g 几何
 * @returns 命中矩形（窗口视口坐标）
 */
export function visibleBox(g: PetGeometry = PET_GEOMETRY): Box {
  const origin = ART_ORIGIN(g);
  const bounds = g.visibleBounds;
  return {
    x: origin.x + g.artWidth * bounds.left,
    y: origin.y + g.artHeight * bounds.top,
    width: g.artWidth * (bounds.right - bounds.left),
    height: g.artHeight * (bounds.bottom - bounds.top),
  };
}

/**
 * 视口坐标 → 立绘画布归一化坐标（0..1）。
 *
 * <p>**不做钳制**：越界点返回越界的 u/v，调用方自己决定是丢弃还是夹紧。
 * 静默钳制会让"点在窗口外只差一点点"与"正边缘"无法区分。</p>
 *
 * @param g 几何
 * @param viewX 视口 x（CSS px）
 * @param viewY 视口 y（CSS px）
 * @returns 归一化坐标
 */
export function toNormalized(g: PetGeometry, viewX: number, viewY: number): UV {
  const origin = ART_ORIGIN(g);
  return { u: (viewX - origin.x) / g.artWidth, v: (viewY - origin.y) / g.artHeight };
}

/**
 * 归一化坐标 → 视口坐标（{@link toNormalized} 的逆运算）。
 *
 * <p>方案B 的锚点（`anchors.json`）与 hitTest 都用归一化坐标存储，
 * 显示时必须靠这里换回来，否则换尺寸就全废。</p>
 *
 * @param g 几何
 * @param u 归一化 x
 * @param v 归一化 y
 * @returns 视口坐标
 */
export function toView(g: PetGeometry, u: number, v: number): Point {
  const origin = ART_ORIGIN(g);
  return { x: origin.x + g.artWidth * u, y: origin.y + g.artHeight * v };
}

/**
 * 需要注入 `documentElement` 的 CSS 变量表（纯数据，不碰 DOM）。
 *
 * <p>CSS 里的静态默认值是首帧兜底（避免首帧闪一下），**逻辑上以本函数为准**。
 * 启动时由 `main.ts` 一次性 `style.setProperty` 注入。</p>
 *
 * @param g 几何
 * @returns CSS 自定义属性名 → 值（含单位）
 */
export function geometryCssVariables(g: PetGeometry = PET_GEOMETRY): Record<string, string> {
  const margin = g.effectMargin;
  return {
    '--pet-art-w': `${g.artWidth}px`,
    '--pet-art-h': `${g.artHeight}px`,
    '--pet-art-glow-pad': `${g.glowPad}px`,
    '--pet-effect-top': `${margin.top}px`,
    '--pet-effect-right': `${margin.right}px`,
    '--pet-effect-bottom': `${margin.bottom}px`,
    '--pet-effect-left': `${margin.left}px`,
    '--pet-art-bubble-h': `${g.bubbleHeight}px`,
    '--pet-ink-h': `${g.inkHeight}px`,
    '--pet-canvas-w': String(g.canvasWidth),
    '--pet-canvas-h': String(g.canvasHeight),
  };
}
