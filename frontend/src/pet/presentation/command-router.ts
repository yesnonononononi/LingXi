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
import { isExpressionId, isMotionId, isPriority, type ExpressionId, type MotionId, type PresentationOp, type Priority } from './types';

/**
 * 动作配方：一条"动作"需要几个 op、各多久、抢多高优先级。
 *
 * <p>时长与优先级来自美术规格书 §6.2 的动作清单（不在代码里另造一套口径）。</p>
 */
export interface MotionRecipe {
  /** 动作本身的持续时间（毫秒）；`null` = 循环/不限时（idle、drag）。 */
  readonly motionMs: number | null;
  /** 动作优先级。 */
  readonly priority: Priority;
  /** 动作是否循环。 */
  readonly loop: boolean;
  /** 同时要切的表情。 */
  readonly expression: ExpressionId | null;
  /** 表情持续时长（毫秒）；动作没有表情时忽略。 */
  readonly expressionMs: number | null;
}

/**
 * 动作 → 配方表。
 *
 * <p>本批能落地的只有 5 条（tap / happy / angry / surprised / wake）+ idle / drag；
 * `sleepy` / `sad` 只有贴片没有逐帧动作，配方里就没有 motion 时长之外的额外戏份。</p>
 */
export const MOTION_RECIPES: Readonly<Record<MotionId, MotionRecipe>> = {
  idle: { motionMs: null, priority: 0, loop: true, expression: null, expressionMs: null },
  tap: { motionMs: 480, priority: 1, loop: false, expression: 'happy', expressionMs: 900 },
  happy: { motionMs: 900, priority: 1, loop: false, expression: 'happy', expressionMs: 900 },
  angry: { motionMs: 800, priority: 1, loop: false, expression: 'angry', expressionMs: 800 },
  surprised: { motionMs: 600, priority: 1, loop: false, expression: 'surprised', expressionMs: 600 },
  sleepy: { motionMs: 1600, priority: 0, loop: false, expression: 'sleepy', expressionMs: 1600 },
  sad: { motionMs: 1200, priority: 0, loop: false, expression: 'sad', expressionMs: 1200 },
  drag: { motionMs: null, priority: 2, loop: true, expression: null, expressionMs: null },
  wake: { motionMs: 500, priority: 2, loop: false, expression: 'surprised', expressionMs: 600 },
};

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
