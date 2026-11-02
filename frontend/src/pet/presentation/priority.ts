/**
 * 打断判定（纯函数，可单测）。
 *
 * <p><b>为什么"眨眼不该把生气表情刷掉"必须在这里解决：</b>眨眼是 180ms 的低优先级 transient
 * 指令，每 2.5~6.5s 一次。如果调度器只会"后到覆盖"，用户刚看到的生气表情会被随机眨眼刷掉，
 * 表现为"表情乱跳"。规则表共用一份实现，调度器（{@link module:pet/presentation/bus}）
 * 只消费判定结果。</p>
 *
 * <p>规则表（设计文档 §3.2，逐行对应本文件的判定分支）：</p>
 * <table>
 *   <tr><th>场景</th><th>结果</th></tr>
 *   <tr><td><b>入态接管（`op.force === true`）</b></td><td><b>立即接管目标层，作废该层旧记录</b></td></tr>
 *   <tr><td>priority 更高</td><td>立即打断</td></tr>
 *   <tr><td>priority 相同</td><td>覆盖（后到优先，连点手感要求）</td></tr>
 *   <tr><td>priority 更低且活动剩余 &gt; 120ms</td><td>拒绝</td></tr>
 *   <tr><td>priority 更低且活动剩余 ≤ 120ms</td><td>排队到到期后应用</td></tr>
 *   <tr><td>睡眠中来 blink</td><td>抑制（不排队）</td></tr>
 *   <tr><td>拖拽中来 ambient</td><td>抑制</td></tr>
 *   <tr><td>同一 op（kind+id）80ms 内重复（仅表现请求）</td><td>合并丢弃</td></tr>
 * </table>
 *
 * <p><b>"入态接管"这一行为什么必须在规则表里、而不是在调用点 if 一下（M6-b 第二轮）：</b>
 * 行为层"进入某个状态"（睡眠 / 生气 / 惊醒 / 拖拽 / 回 idle）是<b>接管</b>，
 * 不是"请求它让我表现一下"——它必须一定落到目标层，并把该层的旧记录作废。
 * 以前入态指令与"眨眼""主进程推来的表情"共用一条通道，于是**优先级 0 的睡眠会被
 * 优先级 1 的生气（TTL 未过期）挡掉，总线静默丢弃，行为层与画面永久不一致**。
 * 把这条语义写成规则表里的一行之后：判定仍然只有一份实现（本函数），
 * 调用点（`bus.dispatch`）只消费三态结果，没有第二处优先级比较。</p>
 *
 * <p><b>为什么入态接管还要绕过 80ms 判重：</b>判重的目的是"同一个表现请求别抖两下"，
 * 而入态接管每次都代表一次<b>新的状态进场</b>（连点第二下的 tap、强制重入睡），
 * 被合并掉就变成"点了没反应"。规则表里因此把判重限定在"表现请求"。</p>
 *
 * @module pet/presentation/priority
 */
import type { LayerId, MotionId, Priority, PresentationOp } from './types';

/** 低优先级指令被"锁住"的剩余时间阈值（毫秒）：活动指令剩余不超过它就排队而不是丢弃。 */
export const INTERRUPT_LOCK_MS = 120;

/** 同一 op 的连点合并窗口（毫秒）。 */
export const DUPLICATE_MERGE_MS = 80;

/** 当前活动指令的快照（由调度器维护）。 */
export interface ActiveOpState {
  /** 活动指令所在层。 */
  readonly layer: LayerId;
  /** 活动指令优先级。 */
  readonly priority: Priority;
  /** 剩余毫秒；null = 不会自行到期（base 层）。 */
  readonly remainingMs: number | null;
  /** 活动指令类别（判重与拖拽抑制需要）。 */
  readonly kind?: 'expression' | 'motion' | 'driven';
  /** 活动指令 id。 */
  readonly id?: string;
}

/** 打断判定入参。 */
export interface InterruptQuery {
  /** 新来的指令。 */
  readonly incoming: PresentationOp;
  /** 当前占主导的活动指令；null = 当前没有任何活动指令（必然应用）。 */
  readonly active: ActiveOpState | null;
  /** 是否处于睡眠表情（`sleepy` / `yawn`）。 */
  readonly sleeping?: boolean;
  /** 当前动作（判"拖拽中来 ambient"用）。 */
  readonly activeMotion?: MotionId | null;
  /** 上一次实际应用的指令（判连点合并用）。 */
  readonly lastApplied?: { readonly kind: string; readonly id: string; readonly atMs: number } | null;
  /** 当前时间（毫秒）；缺省 0，调度器传 `now()`。 */
  readonly nowMs?: number;
}

/** 判定结果。 */
export type InterruptDecision = 'apply' | 'queue' | 'reject';

/**
 * 完整判定（调度器真正需要的三态）。
 *
 * @param query 判定入参
 * @returns `apply` = 立即应用；`queue` = 排到活动指令到期后；`reject` = 丢弃
 */
export function interruptDecision(query: InterruptQuery): InterruptDecision {
  const op = query.incoming;
  // 入态接管（规则表第 1 行）：行为层进入状态时带 force，一律落到目标层
  const takeover = op.force === true;

  // 1) 连点抖动保护：同一 op 在 80ms 内重复 → 合并丢弃。
  //    只作用于"表现请求"：入态接管每次都算一次新的进场，被合并就会读成"点了没反应"。
  const last = query.lastApplied;
  if (!takeover && last && last.kind === op.kind && last.id === String(op.id)) {
    const elapsed = (query.nowMs ?? 0) - last.atMs;
    if (elapsed >= 0 && elapsed < DUPLICATE_MERGE_MS) return 'reject';
  }

  // 2) 睡觉不该眨眼：blink 是 ambient 性质的"生理动作"，睡眠时抑制且不排队
  if (query.sleeping === true && op.kind === 'expression' && op.id === 'blink') return 'reject';

  // 3) 拖拽优先：drag 期间任何 ambient 指令都不该插进来
  if (query.activeMotion === 'drag' && op.layer === 'ambient') return 'reject';

  // 4) 入态接管：状态进场是接管而不是请求，不受优先级与打断锁约束
  //    （这是"睡眠被未过期的生气挡在门外、且永远不会自愈"那条缺陷的正解；
  //      判定仍然只有这一处实现，bus 只消费结果。）
  if (takeover) return 'apply';

  const active = query.active;
  // 5) 没有活动指令 → 直接应用
  if (!active) return 'apply';

  // 6) 优先级更高 → 立即打断
  if (op.priority > active.priority) return 'apply';
  // 7) 优先级相同 → 后到优先（连点手感）
  if (op.priority === active.priority) return 'apply';

  // 8) 优先级更低：看活动指令还剩多久
  if (active.remainingMs === null) return 'reject'; // 永不到期，排队等于永远不执行
  if (active.remainingMs > INTERRUPT_LOCK_MS) return 'reject';
  return 'queue';
}

/**
 * 是否允许立即应用（设计文档 §3.2 的布尔版；`queue` 不算"立即应用"）。
 *
 * @param query 判定入参
 * @returns 是否立即应用
 */
export function canInterrupt(query: InterruptQuery): boolean {
  return interruptDecision(query) === 'apply';
}

/**
 * 给出拒绝/排队原因，供调试日志与排障用。
 *
 * @param query 判定入参
 * @returns 人话原因；允许应用时返回 null
 */
export function suppressionReason(query: InterruptQuery): string | null {
  const decision = interruptDecision(query);
  if (decision === 'apply') return null;
  const op = query.incoming;
  const last = query.lastApplied;
  if (op.force !== true && last && last.kind === op.kind && last.id === String(op.id)) return 'duplicate-within-80ms';
  if (query.sleeping === true && op.kind === 'expression' && op.id === 'blink') return 'sleeping-no-blink';
  if (query.activeMotion === 'drag' && op.layer === 'ambient') return 'drag-blocks-ambient';
  return decision === 'queue' ? 'queued-until-active-expires' : 'lower-priority-locked';
}
