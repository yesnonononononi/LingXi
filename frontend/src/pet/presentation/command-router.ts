/**
 * 指令路由：`pet:command` 信封 → 表现层 op。
 *
 * <p><b>为什么需要它：</b>主进程只该说"发生了什么"（`play: tap`），不该知道"该切哪张贴片、
 * 悬空几帧"。路由把"事件"翻成"表现"，翻错了只改这张表。</p>
 *
 * <p><b>信封是唯一指令入口（设计文档 §8.2 软 seam）：</b>新增 `type` 必须同步
 * `electron/pet-preload.cjs` 的 `KNOWN_COMMAND_TYPES`，否则会被 preload 静默丢弃——
 * 这是本功能最容易踩的坑，`tests/petPresentation.test.ts` 会交叉检查两边清单。</p>
 *
 * @module pet/presentation/command-router
 */
import { MOTION_CATALOG, deriveMotionRecipes, type MotionRecipe } from '../layers/motion-catalog';
import { isExpressionId, isMotionId, isPriority, type MotionId, type PresentationOp } from './types';

/**
 * 动作配方（数据层契约，从 `layers/motion-catalog` 再导出以保证既有引用不变）。
 *
 * <p>M2（等值迁移）之后，配方表的**真源是 `frontend/pet-motions.json`**，
 * 本模块只做消费。字段语义与迁移前逐字相同。</p>
 */
export type { MotionRecipe } from '../layers/motion-catalog';

/**
 * 动作 → 配方表（由动作目录派生）。
 *
 * <p>导出名保持不变：既有测试与调用方（`main.ts`、`tests/petPresentation.test.ts`）零改动。
 * 目录缺项时自动回落到内置冻结表，所以"删掉 `pet-motions.json`"就是安全回退开关。</p>
 */
export const MOTION_RECIPES: Readonly<Record<MotionId, MotionRecipe>> = deriveMotionRecipes(MOTION_CATALOG);

/** 主进程可能推来的指令信封（字段全部按不可信处理）。 */
export interface PetCommandEnvelope {
  /** 指令类型（白名单见 `pet-preload.cjs` 的 `KNOWN_COMMAND_TYPES`）。 */
  readonly type: string;
  /** `play` 用：动作 id。 */
  readonly motion?: unknown;
  /** `expression` 用：表情 id。 */
  readonly expression?: unknown;
  /** 可选：覆盖优先级。 */
  readonly priority?: unknown;
  /** 可选：覆盖持续时间。 */
  readonly durationMs?: unknown;
  /** 排障用原因串。 */
  readonly reason?: unknown;
}

/**
 * 指令路由器。
 *
 * <p>未知类型/未知 id 一律返回空数组并记一条日志——**不抛异常**：
 * 桌宠窗口因为一条脏消息白屏，比忽略它严重得多。</p>
 */
export class CommandRouter {
  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /**
   * 构造路由器。
   *
   * @param options.log 日志出口（缺省静默）
   */
  constructor(options: { readonly log?: (message: string) => void } = {}) {
    this.log = options.log ?? (() => {});
  }

  /**
   * 把一条指令翻译成 0..N 条 op。
   *
   * @param command 指令信封（不可信输入）
   * @returns 待投递到调度总线的 op 列表（可能为空）
   */
  route(command: unknown): PresentationOp[] {
    if (!command || typeof command !== 'object') {
      this.log('[pet] 丢弃非法指令信封（不是对象）');
      return [];
    }
    const envelope = command as PetCommandEnvelope;
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    if (type === 'play') return this.routePlay(envelope);
    if (type === 'expression') return this.routeExpression(envelope);
    // ready / hit-state / visible / ping 由 main.ts 直接消费，不进表现层
    if (type !== '' && type !== 'ready' && type !== 'hit-state' && type !== 'visible' && type !== 'ping') {
      this.log(`[pet] 未知指令类型已忽略: type=${type}`);
    }
    return [];
  }

  /**
   * `{ type:'play', motion:'tap' }` → 动作 op（+ 伴随表情 op）。
   *
   * @param envelope 指令信封
   * @returns op 列表
   */
  private routePlay(envelope: PetCommandEnvelope): PresentationOp[] {
    const motion = envelope.motion;
    if (!isMotionId(motion)) {
      this.log(`[pet] 未知动作已忽略: motion=${String(motion)}`);
      return [];
    }
    const recipe = MOTION_RECIPES[motion];
    const reason = typeof envelope.reason === 'string' && envelope.reason.length > 0
      ? envelope.reason
      : `command:play:${motion}`;
    const priority = isPriority(envelope.priority) ? envelope.priority : recipe.priority;
    const ops: PresentationOp[] = [
      {
        kind: 'motion',
        id: motion,
        layer: 'base',
        priority,
        durationMs: recipe.motionMs ?? undefined,
        loop: recipe.loop,
        fadeMs: 0,
        reason,
      },
    ];
    if (recipe.expression && recipe.expressionMs) {
      ops.push({
        kind: 'expression',
        id: recipe.expression,
        layer: 'transient',
        priority,
        durationMs: recipe.expressionMs,
        fadeMs: 0,
        reason: `${reason}:expression`,
      });
    }
    return ops;
  }

  /**
   * `{ type:'expression', expression:'happy' }` → 表情 op。
   *
   * @param envelope 指令信封
   * @returns op 列表
   */
  private routeExpression(envelope: PetCommandEnvelope): PresentationOp[] {
    const expression = envelope.expression;
    if (!isExpressionId(expression)) {
      this.log(`[pet] 未知表情已忽略: expression=${String(expression)}`);
      return [];
    }
    const priority = isPriority(envelope.priority) ? envelope.priority : 1;
    const durationMs = Number.isFinite(envelope.durationMs) && (envelope.durationMs as number) > 0
      ? (envelope.durationMs as number)
      : 1200;
    const reason = typeof envelope.reason === 'string' && envelope.reason.length > 0
      ? envelope.reason
      : `command:expression:${expression}`;
    return [
      {
        kind: 'expression',
        id: expression,
        layer: 'transient',
        priority,
        durationMs,
        fadeMs: 0,
        reason,
      },
    ];
  }
}
