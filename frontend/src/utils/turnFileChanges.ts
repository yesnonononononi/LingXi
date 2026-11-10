/**
 * 轮次文件改动清单的纯投影：后端汇总 → 可渲染行。
 *
 * <p>「同一文件本轮多次编辑合并成一行」由后端重算净改动，前端只做展示投影，
 * 绝不在这里累加 {@code plusLines}/{@code minusLines} —— 逐次累加会把「改过去又改回来」
 * 记成 +2/−2，而真实净改动是 0。</p>
 */
import type {FilePreviewEditRef} from '../types/filePreview';

/** 与后端 `TurnFileEdit` 同形（`GET /a/file-edits/turns/{turnId}/summary` 的 data 元素）。 */
export interface TurnFileChangeItem {
  filePath: string;
  plusLines?: number;
  minusLines?: number;
  edits?: number;
  created?: boolean;
  executionId?: string | null;
  recordId?: string | null;
  /** 统一差异正文；**仅最新轮次有值**，历史轮次为 null（契约：历史只留行数）。 */
  diff?: string | null;
}

export interface TurnFileChangeRow {
  filePath: string;
  /** 文件名（路径末段），清单主文案。 */
  name: string;
  /** 所在目录，副文案；根级文件为空串。 */
  dir: string;
  plusLines: number;
  minusLines: number;
  edits: number;
  created: boolean;
  /** 点开差异视图的定位；两个标识缺一即为 null（该行只展示、不可点）。 */
  edit: FilePreviewEditRef | null;
}

/** 路径末段；同时容忍 Windows 与 POSIX 分隔符。 */
function splitPath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  if (cut < 0) return { name: normalized, dir: '' };
  return { name: normalized.slice(cut + 1), dir: normalized.slice(0, cut) };
}

export function buildTurnFileChangeRows(items?: TurnFileChangeItem[] | null): TurnFileChangeRow[] {
  if (!items?.length) return [];
  return items.map(item => {
    const {name, dir} = splitPath(item.filePath ?? '');
    // 只有最新轮次带差异正文；没有正文的行即便有标识也不给入口，免得点开一片空白。
    const canOpenDiff = !!(item.executionId && item.recordId && item.diff);
    return {
      filePath: item.filePath ?? '',
      name,
      dir,
      plusLines: item.plusLines ?? 0,
      minusLines: item.minusLines ?? 0,
      edits: item.edits ?? 0,
      created: !!item.created,
      edit: canOpenDiff ? {executionId: item.executionId!, recordId: item.recordId!} : null
    };
  });
}

/** 全轮合计增删行数：表头用它给一眼可见的量级，同样只做加法不重算差异。 */
export function turnFileChangeTotals(rows: TurnFileChangeRow[]): { plusLines: number; minusLines: number } {
  return rows.reduce(
    (total, row) => ({
      plusLines: total.plusLines + row.plusLines,
      minusLines: total.minusLines + row.minusLines
    }),
    {plusLines: 0, minusLines: 0}
  );
}

/** 只取预筛需要的字段，避免把整个 ChatMessage 拖进纯函数签名。 */
export interface TurnEditProbe {
  turnId?: string | null;
  fileEdits?: { filePath: string }[] | null;
  toolCalls?: { toolName?: string | null }[] | null;
}

/**
 * 哪些轮次真的改过文件（按 turnId 索引）。
 *
 * <p>清单卡片要按轮次向后端要汇总。若对每一条已完成轮次都发请求，一页 20 轮就是 20 个请求；
 * 这里用消息上已有的工具轨迹先预筛，没有编辑痕迹的轮次既不挂卡片也不发请求。</p>
 *
 * @param messages 会话消息（顺序无关）
 * @param isEditTool 编辑工具判定，由调用方注入以免本模块依赖工具字典
 */
export function collectTurnFileChangeFlags(
  messages: TurnEditProbe[] | null | undefined,
  isEditTool: (toolName?: string | null) => boolean
): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const message of messages ?? []) {
    const turnId = message.turnId;
    if (!turnId || flags.get(turnId)) continue;
    const edited = (message.fileEdits?.length ?? 0) > 0
      || (message.toolCalls ?? []).some(tool => isEditTool(tool.toolName));
    if (edited) flags.set(turnId, true);
  }
  return flags;
}
