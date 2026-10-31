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
 *   <tr><td>priority 更高</td><td>立即打断</td></tr>
 *   <tr><td>priority 相同</td><td>覆盖（后到优先，连点手感要求）</td></tr>
 *   <tr><td>priority 更低且活动剩余 &gt; 120ms</td><td>拒绝</td></tr>
 *   <tr><td>priority 更低且活动剩余 ≤ 120ms</td><td>排队到到期后应用</td></tr>
 *   <tr><td>睡眠中来 blink</td><td>抑制（不排队）</td></tr>
 *   <tr><td>拖拽中来 ambient</td><td>抑制</td></tr>
 *   <tr><td>同一 op（kind+id）80ms 内重复</td><td>合并丢弃</td></tr>
 * </table>
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

  // 1) 连点抖动保护：同一 op 在 80ms 内重复 → 合并丢弃
  const last = query.lastApplied;
  if (last && last.kind === op.kind && last.id === String(op.id)) {
    const elapsed = (query.nowMs ?? 0) - last.atMs;
    if (elapsed >= 0 && elapsed < DUPLICATE_MERGE_MS) return 'reject';
  }

  // 2) 睡觉不该眨眼：blink 是 ambient 性质的"生理动作"，睡眠时抑制且不排队
  if (query.sleeping === true && op.kind === 'expression' && op.id === 'blink') return 'reject';

  // 3) 拖拽优先：drag 期间任何 ambient 指令都不该插进来
  if (query.activeMotion === 'drag' && op.layer === 'ambient') return 'reject';

  const active = query.active;
  // 4) 没有活动指令 → 直接应用
  if (!active) return 'apply';

  // 5) 优先级更高 → 立即打断
  if (op.priority > active.priority) return 'apply';
  // 6) 优先级相同 → 后到优先（连点手感）
  if (op.priority === active.priority) return 'apply';

  // 7) 优先级更低：看活动指令还剩多久
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
  if (last && last.kind === op.kind && last.id === String(op.id)) return 'duplicate-within-80ms';
  if (query.sleeping === true && op.kind === 'expression' && op.id === 'blink') return 'sleeping-no-blink';
  if (query.activeMotion === 'drag' && op.layer === 'ambient') return 'drag-blocks-ambient';
  return decision === 'queue' ? 'queued-until-active-expires' : 'lower-priority-locked';
}
