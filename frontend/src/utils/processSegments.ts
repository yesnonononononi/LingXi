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

export interface ProcessSummary {
  toolNames: string[];
  targets: string[];
  failedCount: number;
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
  const summary: ProcessSummary = { toolNames: [], targets: [], failedCount: 0,
    pendingCount: 0, runningCount: 0, unknownCount: 0, latest: items.at(-1) };
  for (const item of items) {
    const status = item.tool ? resolveProcessToolStatus(item.tool, subSessions) : item.step?.status;
    if (status === 'failed') summary.failedCount++;
    else if (status === 'pending') summary.pendingCount++;
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
