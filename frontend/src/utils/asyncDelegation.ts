/**
 * 协作式（异步）委派的组件层共享工具。
 *
 * <p>协作模式下 `call_sub_agent` 会<b>立即</b>返回，工具自身状态（`tc.status`）随即变成 success，
 * 但子代理可能还在跑。组件若继续读 `tc.status`，就会把「还在跑」误显示成「已完成」。
 * 这里提供两个判定：① 这次是否是协作式委派；② 由子会话权威态派生展示态。</p>
 *
 * <p>遵守 C2：不碰流式渲染链路，数据只从 `tc.query` / `tc.result` 与 `props.subSessions` 解析。
 * 子会话「运行态 → 展示态」的映射复用 {@link toSubItemStatus}，本模块不重写它。</p>
 */
import type { SubItemStatus, SubSessionVO, ToolCallTrace } from '../types/chat';
import { toSubItemStatus } from './subSessionStatus';
import { toObject } from './json';

/** 协作式工具结果里 `runtimeMode` 的固定取值（与后端 AsyncDelegationResultRenderer 对齐）。 */
const RUNTIME_MODE_ASYNC = 'ASYNC';

/** 判定一次子代理工具调用是否是协作式（异步）委派：入参带 runtime_mode=async，或结果带 runtimeMode=ASYNC。 */
export function isAsyncDelegation(tc?: ToolCallTrace | null): boolean {
  if (!tc) return false;
  const args = toObject(tc.query, {});
  if (String(args.runtime_mode ?? '').trim().toLowerCase() === 'async') return true;
  const result = toObject(tc.result, {});
  return String(result.runtimeMode ?? '').trim().toUpperCase() === RUNTIME_MODE_ASYNC;
}

/**
 * 协作式委派成员行的展示态：<b>优先子会话权威态</b>（`runStatus` + `lastOutcome`）。
 *
 * <p>子会话态缺省（第一条实时事件到达前、`props.subSessions` 里还没这个子会话）时：
 * <b>只抑制协作式工具态的 success</b>（它只代表「委派已受理」，不代表子代理完成），
 * 其余状态一律如实回落工具调用状态；阻塞式则整支回落（那里 success 等价子代理真的跑完了）。</p>
 */
export function asyncSubSessionStatus(sub: SubSessionVO | undefined, tc: ToolCallTrace): SubItemStatus {
  if (sub) {
    return toSubItemStatus(sub.runStatus, sub.lastOutcome);
  }
  // 协作式下工具会「立即成功返回」，但此刻子代理定义上仍在跑（子执行要经过
  // createSubSession → record → createExecution → 起 loop，可能 1~2 秒）——
  // 唯一要抑制的是工具态的 success：它只代表「委派已受理」，不代表子代理完成。
  // 其余状态必须如实回落：工具自身失败（如线程池拒绝提交、返回 ToolResult.err）时
  // 子会话根本不会出现，若无条件判「进行中」，该成员行会永远停在「进行中」，且等不到权威态纠正。
  if (isAsyncDelegation(tc)) {
    return tc.status === 'success' ? 'running' : toSubItemStatusFromToolStatus(tc.status);
  }
  return toSubItemStatusFromToolStatus(tc.status);
}

/** 工具调用四态 → 展示态（仅作子会话态缺省时的回落，不参与主判定）。 */
function toSubItemStatusFromToolStatus(status?: ToolCallTrace['status']): SubItemStatus {
  switch (status) {
    case 'calling':
    case 'pending':
      return 'running';
    case 'failed':
      return 'failed';
    case 'success':
      return 'completed';
    default:
      return 'unknown';
  }
}

/**
 * 展示态 → 状态点语义色（与既有工具色点同一套语义）：
 * running / suspended = 琥珀脉冲、completed = 绿、failed = 红、其余 = 灰。
 */
export function subItemStatusDotClass(status: SubItemStatus): string {
  switch (status) {
    case 'running':
    case 'suspended':
      return 'bg-amber-400 animate-pulse';
    case 'completed':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-gray-400';
  }
}

/** 展示态 → 中文文案（子会话详情状态栏用）。 */
export function subItemStatusLabel(status: SubItemStatus): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'suspended':
      return '等待审批';
    case 'completed':
      return '执行完成';
    case 'failed':
      return '执行失败';
    case 'cancelled':
      return '已取消';
    default:
      return '—';
  }
}
