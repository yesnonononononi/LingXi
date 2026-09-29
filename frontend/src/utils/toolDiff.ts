/**
 * 工具文件变更（+N / -M）解析的唯一实现。
 *
 * 收敛原因：同一套 diff 解析逻辑此前被复制到 4 处，且已发生分叉：
 *   - components/chat/ChatMessageItem.vue:287-337（getToolDiffStat，4 段来源）
 *   - components/chat/SubSessionDetailDrawer.vue:82-96（getToolDiffStat，2 段来源）
 *   - services/chat.ts:273-288、services/chat.ts:1056-1074（直接解析 resultStr）
 * 这些解析点用空 `catch {}` 完全吞掉 JSON 解析异常，导致文件 diff 静默消失：
 *   services/chat.ts 内 4 处（:278/:288/:1061/:1074）+ 本域 2 处
 *   （ChatMessageItem.vue:310、SubSessionDetailDrawer.vue:93，随本次收敛消除），共 6 处。
 *
 * ============================ 导出签名（务必按此使用） ============================
 *
 *   // ① 组件侧：从「工具调用对象」解析出 diff 展示数据。
 *   //    返回 null 表示「不是文件编辑工具 / 没有可用 diff」；
 *   //    返回对象时 plusLines / minusLines 为 number，未知字段为 null（区分「未知」与「0」）。
 *   parseToolDiff(input: ToolDiffInput): ToolDiffStat | null
 *
 *   // ② 服务侧（实施者 B 用于替换 services/chat.ts:273-288 与 :1056-1074）：
 *   //    解析工具 result（JSON 字符串）中的 plusLines / minusLines。
 *   //    result 非字符串 / 空串 / 解析失败 → 返回 { plusLines: null, minusLines: null }，
 *   //    解析失败时 console.warn 带上下文（不再静默吞异常）。
 *   parseToolDiffFromResult(result: unknown, context?: string): ToolDiffStat
 *
 *   interface ToolDiffStat { plusLines: number | null; minusLines: number | null }
 *
 *   interface ToolDiffInput {
 *     toolName?: string;        // 工具名（用于 isEditFileTool 判定）
 *     category?: string;        // 后端分类（'写入' 视为可能含 diff）
 *     plusLines?: number;       // 结构化直出字段（优先级最高）
 *     minusLines?: number;
 *     result?: string;          // 工具返回原始字符串（JSON: { plusLines, minusLines }）
 *     description?: string;     // 自然语言描述，回退正则 /\+(\d+)\s+-(\d+)/
 *     target?: string;          // 目标路径，用于 fileEdits 匹配
 *     fileEdits?: FileEditRecord[]; // 消息关联的文件编辑记录
 *     context?: string;         // 仅用于告警文案（如 `toolCall xxx`）
 *   }
 *
 * ================================ B 的替换示例 ================================
 *
 *   // services/chat.ts:273-288（命中已存在的 targetTool 时）
 *   const diff = parseToolDiffFromResult(resultStr, `toolCall ${targetTool.id}`);
 *   if (diff.plusLines !== null) targetTool.plusLines = diff.plusLines;
 *   if (diff.minusLines !== null) targetTool.minusLines = diff.minusLines;
 *
 *   // services/chat.ts:1056-1074（未命中、新建 toolCall 时）
 *   const diff = parseToolDiffFromResult(resultStr);
 *   // push({ ..., plusLines: diff.plusLines ?? undefined, minusLines: diff.minusLines ?? undefined })
 *   // 注意：不要用 `?? 0` 抹平——null 表示「未知」，0 表示「确实无改动」。
 * ============================================================================
 */

import { isEditFileTool, TOOL_CATEGORY } from './toolMeta';
import { parseJsonSafe } from './json';
import type { FileEditRecord } from '../types/chat';

export interface ToolDiffStat {
  plusLines: number | null;
  minusLines: number | null;
}

export interface ToolDiffInput {
  toolName?: string;
  category?: string;
  plusLines?: number;
  minusLines?: number;
  result?: string;
  description?: string;
  target?: string;
  fileEdits?: FileEditRecord[];
  context?: string;
}

/** 自然语言描述中的 `+N -M` 回退匹配 */
const DIFF_DESC_RE = /\+(\d+)\s+-(\d+)/;

const EMPTY_STAT: ToolDiffStat = { plusLines: null, minusLines: null };

/**
 * 从工具 result（JSON 字符串）解析 plusLines / minusLines。
 * 非字符串、空串、解析失败均返回「未知」（字段为 null），解析失败带上下文告警。
 */
export function parseToolDiffFromResult(result: unknown, context = 'toolDiff'): ToolDiffStat {
  // 原实现只处理字符串 result（对象形态历史上不会出现），此处保持同一口径。
  if (typeof result !== 'string') return { ...EMPTY_STAT };

  // 统一走 utils/json.ts 的 parseJsonSafe：失败时 console.warn，不再 `catch {}` 静默吞掉。
  const obj = parseJsonSafe<Record<string, any> | null>(result, null, context);
  if (!obj || typeof obj !== 'object') return { ...EMPTY_STAT };

  return {
    plusLines: obj.plusLines === undefined ? null : (obj.plusLines as number),
    minusLines: obj.minusLines === undefined ? null : (obj.minusLines as number)
  };
}

/**
 * 从「工具调用对象」解析 diff 展示数据。
 * 来源优先级：结构化字段 → result(JSON) → description(+N -M) → fileEdits 路径匹配。
 * 返回 null 表示该工具不产生 diff 或没有任何可用来源。
 */
export function parseToolDiff(input: ToolDiffInput): ToolDiffStat | null {
  const { toolName, category, plusLines, minusLines, result, description, target, fileEdits, context } = input;

  // 仅文件编辑工具，或后端显式标注为「写入」分类的工具，才可能有 diff。
  if (!isEditFileTool(toolName) && category !== TOOL_CATEGORY.WRITE) {
    return null;
  }

  // 1. 结构化直出字段
  if (plusLines !== undefined || minusLines !== undefined) {
    return {
      plusLines: plusLines ?? null,
      minusLines: minusLines ?? null
    };
  }

  // 2. 从 result 解析（后端 edit_file 返回 JSON: { path, created, plusLines, minusLines }）
  if (result !== undefined) {
    const fromResult = parseToolDiffFromResult(result, context ?? 'toolDiff');
    if (fromResult.plusLines !== null || fromResult.minusLines !== null) {
      return fromResult;
    }
  }

  // 3. 从 description 回退提取 (+N -M)
  if (description) {
    const m = description.match(DIFF_DESC_RE);
    if (m) {
      return {
        plusLines: parseInt(m[1], 10),
        minusLines: parseInt(m[2], 10)
      };
    }
  }

  // 4. 从消息关联的 fileEdits 按目标路径匹配
  if (fileEdits?.length) {
    const fe = fileEdits.find(f => f.filePath === target || (target ? f.filePath.endsWith(target) : false));
    if (fe && (fe.plusLines !== undefined || fe.minusLines !== undefined)) {
      return {
        plusLines: fe.plusLines ?? null,
        minusLines: fe.minusLines ?? null
      };
    }
  }

  return null;
}
