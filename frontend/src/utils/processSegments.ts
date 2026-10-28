import type { AiMessageItem, ProcessTimelineItem, SubSessionVO, ToolCallTrace } from '../types/chat';
import type { ImageProcessItem } from './readImageTools';
import { groupReadImageTools } from './readImageTools';
import { resolveSubAgentToolCalls } from './processTimeline';
import { extractSubAgentParams, isSubAgentTool, resolveToolMeta } from './toolMeta';
import { asyncSubSessionStatus } from './asyncDelegation';

export interface ProcessSegment {
  kind: 'process';
  id: string;
  items: ProcessTimelineItem[];
  detailItems: ImageProcessItem[];
  closed: boolean;
}

export interface ProcessText {
  kind: 'text';
  id: string;
  message: AiMessageItem;
}

export type ProcessPart = ProcessSegment | ProcessText;

/** 文本先确定边界，协同成员和读图只在各自段内合并。 */
export function buildProcessSegments(
  items: ProcessTimelineItem[], subSessions: SubSessionVO[] = [], sessionId?: string | number
): ProcessPart[] {
  const parts: ProcessPart[] = [];
  let segment: ProcessSegment | undefined;
  for (const item of items) {
    if (item.type === 'prompt_card') continue;
    if (item.type === 'intermediate_ai' && item.message) {
      if (segment) segment.closed = true;
      segment = undefined;
      parts.push({ kind: 'text', id: item.id, message: item.message });
      continue;
    }
    if (!segment) {
      segment = { kind: 'process', id: `process:${item.id}`, items: [], detailItems: [], closed: false };
      parts.push(segment);
    }
    segment.items.push(item);
  }
  for (const part of parts) {
    if (part.kind !== 'process') continue;
    const members = resolveSubAgentToolCalls(part.items.flatMap(item => item.tool ? [item.tool] : []), subSessions);
    let insertedMembers = false;
    const details: ProcessTimelineItem[] = [];
    for (const item of part.items) {
      if (item.tool && isSubAgentTool(item.tool.toolName, item.tool.category)) {
        if (!insertedMembers) {
          details.push({ ...item, id: `sub-agents:${item.id}`, type: 'sub_agent', subAgents: members });
          insertedMembers = true;
        }
      } else details.push(item);
    }
    part.detailItems = groupReadImageTools(details, sessionId);
  }
  return parts;
}

/**
 * 过程段折叠行的呈现模式。
 *
 * <ul>
 *   <li>{@code live}：展示「最新一步」（最新工具名 / 思考 + 最新一步正文或命令意图）。</li>
 *   <li>{@code summary}：展示「整段概览」（工具类别去重列举 + 目标列表）。</li>
 * </ul>
 */
export type ProcessSegmentMode = 'live' | 'summary';

/** {@link resolveProcessSegmentMode} 的判据集合：只收事实，不接受派生文案。 */
export interface ProcessSegmentModeFacts {
  /** 段是否已被后续 text 收尾 —— 没有下一段 text 时段仍可能继续增长。 */
  closed: boolean;
  /** 整轮是否仍在进行（挂起 / 等待审批都算未结束）。 */
  ongoing: boolean;
  /** 段内仍处于调用中 / 运行中的步骤数。 */
  runningCount: number;
  /** 段内仍等待用户确认或状态待定的步骤数。 */
  pendingCount: number;
}

/**
 * 判定过程段该呈现为实时一步还是整段概览。
 *
 * <p>判定理由：</p>
 * <ul>
 *   <li><b>只有 closed 的段才可以汇总</b>：段边界由「后面出现了下一段 text」确定。未 closed 的段
 *       随时可能追加思考或工具，此时给出整段概览会把「还会变的事实」当成结论展示，用户看到的
 *       标题和下一步会自相矛盾。</li>
 *   <li><b>running / pending 一票否决</b>：只要还有调用中、待确认或待定的步骤，段就仍在演进，
 *       概览会把「正在跑的那一步」淹没在旧集合里；实时一步才是用户此刻该看到的信息。</li>
 *   <li><b>整轮已结束则无条件是 summary</b>：轮次收尾后最后一段永远不会被 text 收尾（它后面没有
 *       文本了），也没有任何步骤会再变化，此时再展示「最新一步」是误导 —— 历史轮次应当一眼看到
 *       整段做了什么。</li>
 * </ul>
 *
 * @param facts 段边界、整轮进行态与段内步骤计数
 * @returns 折叠行的呈现模式
 */
export function resolveProcessSegmentMode(facts: ProcessSegmentModeFacts): ProcessSegmentMode {
  const { closed, ongoing, runningCount, pendingCount } = facts;
  if (closed && runningCount <= 0 && pendingCount <= 0) return 'summary';
  if (!ongoing) return 'summary';
  return 'live';
}

export interface ProcessSummary {
  toolNames: string[];
  targets: string[];
  pendingCount: number;
  runningCount: number;
  unknownCount: number;
  latest?: ProcessTimelineItem;
}

/** 子代理是否完成以子会话为准，不能把委派工具返回当成任务完成。 */
function resolveProcessToolStatus(tool: ToolCallTrace, subSessions: SubSessionVO[]): ToolCallTrace['status'] {
  if (!isSubAgentTool(tool.toolName, tool.category)) return tool.status;
  const params = extractSubAgentParams(tool);
  const sessionId = tool.subSessionId ?? params.subSessionId;
  const agentId = params.agentId ?? tool.subAgentId;
  const sub = subSessions.find(item => sessionId != null && String(item.id) === String(sessionId))
    ?? subSessions.find(item => agentId != null && String(item.agentId) === String(agentId));
  switch (asyncSubSessionStatus(sub, tool)) {
    case 'running': return 'calling';
    case 'suspended': return 'pending';
    case 'completed': return 'success';
    case 'failed':
    case 'cancelled': return 'failed';
    default: return 'unknown';
  }
}

/** 摘要只派生事实，不保存文案；最新活动沿用时间线位置，不按事件到达时间跳动。 */
export function summarizeProcess(items: ProcessTimelineItem[], subSessions: SubSessionVO[] = []): ProcessSummary {
  const names = new Set<string>();
  const targets = new Set<string>();
  const summary: ProcessSummary = { toolNames: [], targets: [],
    pendingCount: 0, runningCount: 0, unknownCount: 0, latest: items.at(-1) };
  for (const item of items) {
    const status = item.tool ? resolveProcessToolStatus(item.tool, subSessions) : item.step?.status;
    if (status === 'pending') summary.pendingCount++;
    else if (status === 'calling' || status === 'running') summary.runningCount++;
    else if (status === 'unknown') summary.unknownCount++;
    if (!item.tool) continue;
    names.add(item.tool.toolName);
    const target = resolveToolMeta({ toolName: item.tool.toolName, args: item.tool.args ?? item.tool.query }).target;
    const basename = target.split(/[\\/]/).filter(Boolean).at(-1);
    if (basename) targets.add(basename);
  }
  summary.toolNames = [...names];
  summary.targets = [...targets];
  return summary;
}
