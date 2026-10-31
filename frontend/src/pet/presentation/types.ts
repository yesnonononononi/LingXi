/**
 * 表现层指令契约（方案A/B 共用的公共语言）。
 *
 * <p><b>为什么要有这一层：</b>现在"切表情"是换 `background-position`、"播动作"是加 class、
 * 将来接 Live2D 是 `model.motion()`——三种写法三种调度。收敛成一种数据结构
 * {@link PresentationOp} 之后，调度器只产出 op，实现只消费 op，**换实现不改调度**。</p>
 *
 * <p><b>枚举名与美术规格书逐条对应，定下后不许再改</b>（改了等于让美术白画）：
 * `ExpressionId` ↔ 规格书 §5 的 E1–E8（外加预留的 `yawn`），
 * `MotionId` ↔ 规格书 §6.2 的运行时动作清单。
 * 方案B 的 Cubism 映射表就写在这套 id 上（设计文档 §3.4）。</p>
 *
 * @module pet/presentation/types
 */

/**
 * 表情档位。
 *
 * <p>前 8 个与美术规格书 §5 的 E1–E8 一一对应；`yawn`（打哈欠）为行为层预留，
 * 本批不产出，但枚举先定死，避免下一批改名牵连 Cubism 映射。</p>
 */
export type ExpressionId =
  | 'neutral'
  | 'blink'
  | 'happy'
  | 'shy'
  | 'angry'
  | 'sad'
  | 'surprised'
  | 'sleepy'
  | 'yawn';

/** 动作档位（与美术规格书 §6.2 的运行时动作清单一一对应）。 */
export type MotionId =
  | 'idle'
  | 'tap'
  | 'happy'
  | 'angry'
  | 'surprised'
  | 'sleepy'
  | 'sad'
  | 'drag'
  | 'wake';

/**
 * 叠加层。
 *
 * <ul>
 *   <li>`base`：常驻层（默认表情 / idle 动作），没有 TTL；</li>
 *   <li>`transient`：短时覆盖（眨眼、点一下的反应），必有 TTL；</li>
 *   <li>`ambient`：环境层（呼吸相位、由行为层驱动的氛围），可被 `drag` 挤掉。</li>
 * </ul>
 */
export type LayerId = 'base' | 'transient' | 'ambient';

/**
 * 优先级。
 *
 * <ul>
 *   <li>`0`：可被任何东西打断（眨眼、氛围）；</li>
 *   <li>`1`：普通反应（被点击、切表情）；</li>
 *   <li>`2`：打断一切（拖拽、惊醒）。</li>
 * </ul>
 */
export type Priority = 0 | 1 | 2;

/**
 * 无分层资产时也能动的"参数驱动"档。
 *
 * <p>值域（进 CSS 前会按此钳制，见 `sprite-presentation.ts` 的 `DRIVEN_CSS_VARIABLES`）：</p>
 * <ul>
 *   <li>`tailAngle` / `earLAngle` / `earRAngle`：角度（-30..30 度）；</li>
 *   <li>`haloOpacity`：0..1；</li>
 *   <li>`gazeX`：-1..1（-1 看左、1 看右）。</li>
 * </ul>
 *
 * <p>光晕不进模型（方案B 也不进），它属于"表现层之外的装饰层"，两种实现都留在 DOM。</p>
 */
export type DrivenParam = 'tailAngle' | 'earLAngle' | 'earRAngle' | 'haloOpacity' | 'gazeX';

/** 一条表现层指令。 */
export interface PresentationOp {
  /** 指令类别。 */
  readonly kind: 'expression' | 'motion' | 'driven';
  /** 目标 id（与 kind 对应：expression→ExpressionId，motion→MotionId，driven→DrivenParam）。 */
  readonly id: ExpressionId | MotionId | DrivenParam;
  /** 目标层。 */
  readonly layer: LayerId;
  /** 优先级。 */
  readonly priority: Priority;
  /** 持续时间（毫秒）；缺省 = 无限（base 层默认）。 */
  readonly durationMs?: number;
  /**
   * 参数值（**仅 `kind='driven'` 使用**）。
   *
   * <p>设计文档 §3.1 的草稿只给了 `id`，但 `driven` 档没有值就无法表达"尾巴摆到 +3°"，
   * 故补一个可选 `value`；值域与钳制规则见 {@link DrivenParam}。
   * 其余 kind 传了也会被忽略。</p>
   */
  readonly value?: number;
  /** 是否循环（仅 motion 有意义）。 */
  readonly loop?: boolean;
  /** 交叉淡化时长（毫秒）；立牌硬切 = 0，Live2D 才需要 120。 */
  readonly fadeMs?: number;
  /** 排障用：谁下的指令。 */
  readonly reason: string;
}

/** 表现层只读快照（测试断言与调试面板共用）。 */
export interface PresentationState {
  /** 当前主表情。 */
  readonly expression: ExpressionId;
  /** 当前动作；null = 没有动作在跑。 */
  readonly motion: MotionId | null;
  /** 参数驱动档的当前值。 */
  readonly driven: Readonly<Record<DrivenParam, number>>;
}

/**
 * 表现层实现接口（方案A 静态立牌 / 方案B Live2D 都实现它）。
 *
 * <p>这是设计文档 §8.2 的 seam S1：换实现时 `main.ts` 只换一行构造。</p>
 */
export interface PetPresentation {
  /** 立即应用一条指令（实现内部负责写入面：贴片 src / CSS 变量 / `data-*`）。 */
  apply(op: PresentationOp): void;
  /** 预准备（预解码贴片 / 预加载 motion），不阻塞 apply。 */
  prepare(next: PresentationOp): Promise<void>;
  /** 只读快照。 */
  readonly state: PresentationState;
  /** 释放资源（Live2D 的 WebGL 上下文必须显式销毁）。 */
  dispose(): void;
}

/** 全部表情 id（顺序与美术规格书 §5 的 E1–E8 一致，`yawn` 排最后）。 */
export const EXPRESSION_IDS: readonly ExpressionId[] = [
  'neutral',
  'blink',
  'happy',
  'shy',
  'angry',
  'sad',
  'surprised',
  'sleepy',
  'yawn',
];

/** 全部动作 id（顺序与美术规格书 §6.2 一致）。 */
export const MOTION_IDS: readonly MotionId[] = [
  'idle',
  'tap',
  'happy',
  'angry',
  'surprised',
  'sleepy',
  'sad',
  'drag',
  'wake',
];

/** 全部参数驱动档。 */
export const DRIVEN_PARAMS: readonly DrivenParam[] = [
  'tailAngle',
  'earLAngle',
  'earRAngle',
  'haloOpacity',
  'gazeX',
];

/** 每个参数驱动档的中性值（回落到这里，不做残留）。 */
export const DRIVEN_NEUTRAL: Readonly<Record<DrivenParam, number>> = {
  tailAngle: 0,
  earLAngle: 0,
  earRAngle: 0,
  haloOpacity: 0.55,
  gazeX: 0,
};

/** 初始表现层状态（base 层 = 默认表情 + idle）。 */
export const DEFAULT_PRESENTATION_STATE: PresentationState = {
  expression: 'neutral',
  motion: 'idle',
  driven: DRIVEN_NEUTRAL,
};

/**
 * 判断是否合法表情 id。
 *
 * @param value 待判断值
 * @returns 是否合法
 */
export function isExpressionId(value: unknown): value is ExpressionId {
  return typeof value === 'string' && (EXPRESSION_IDS as readonly string[]).includes(value);
}

/**
 * 判断是否合法动作 id。
 *
 * @param value 待判断值
 * @returns 是否合法
 */
export function isMotionId(value: unknown): value is MotionId {
  return typeof value === 'string' && (MOTION_IDS as readonly string[]).includes(value);
}

/**
 * 判断是否合法参数驱动档。
 *
 * @param value 待判断值
 * @returns 是否合法
 */
export function isDrivenParam(value: unknown): value is DrivenParam {
  return typeof value === 'string' && (DRIVEN_PARAMS as readonly string[]).includes(value);
}

/**
 * 判断是否合法优先级。
 *
 * @param value 待判断值
 * @returns 是否合法（只接受 0 / 1 / 2）
 */
export function isPriority(value: unknown): value is Priority {
  return value === 0 || value === 1 || value === 2;
}

/**
 * 校验一条 op（外部命令进来的都是 `unknown`，不能直接信）。
 *
 * @param op 待校验对象
 * @returns 是否是一条结构完整的 op
 */
export function isPresentationOp(op: unknown): op is PresentationOp {
  if (!op || typeof op !== 'object') return false;
  const candidate = op as Partial<PresentationOp>;
  if (candidate.kind !== 'expression' && candidate.kind !== 'motion' && candidate.kind !== 'driven') return false;
  if (candidate.layer !== 'base' && candidate.layer !== 'transient' && candidate.layer !== 'ambient') return false;
  if (!isPriority(candidate.priority)) return false;
  if (typeof candidate.reason !== 'string') return false;
  if (candidate.durationMs !== undefined && (!Number.isFinite(candidate.durationMs) || (candidate.durationMs as number) <= 0)) {
    return false;
  }
  if (candidate.value !== undefined && !Number.isFinite(candidate.value)) return false;
  if (candidate.kind === 'expression') return isExpressionId(candidate.id);
  if (candidate.kind === 'motion') return isMotionId(candidate.id);
  return isDrivenParam(candidate.id);
}
