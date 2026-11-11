/**
 * 轮次文件改动清单的纯投影：轮次视图（{@code TurnViewVO.fileChanges}）→ 可渲染行。
 *
 * <p>「同一文件本轮多次编辑合并成一行」由后端重算净改动，前端只做展示投影，
 * 绝不在这里累加 {@code plusLines}/{@code minusLines} —— 逐次累加会把「改过去又改回来」
 * 记成 +2/−2，而真实净改动是 0。</p>
 *
 * <p><b>不再有「哪些轮次改过文件」的预筛</b>：那份预筛是给「每张卡片各自发请求」用的；
 * 现在清单随视图下发，有没有改动由数据本身回答。</p>
 */
import type {TurnFileChangeVO} from '../types/block';
import type {FilePreviewEditRef} from '../types/filePreview';

export type TurnFileChangeItem = TurnFileChangeVO;

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
  /** 点开差异视图的定位；差异不可用或缺标识即为 null（该行只展示、不可点）。 */
  edit: FilePreviewEditRef | null;
}

/** 路径末段；同时容忍 Windows 与 POSIX 分隔符。 */
function splitPath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  if (cut < 0) return { name: normalized, dir: '' };
  return { name: normalized.slice(cut + 1), dir: normalized.slice(0, cut) };
}

export function buildTurnFileChangeRows(items?: TurnFileChangeVO[] | null): TurnFileChangeRow[] {
  if (!items?.length) return [];
  return items.map(item => {
    const {name, dir} = splitPath(item.filePath ?? '');
    // 可点与否只看后端给的 diffAvailable（有可重放记录即为真）+ 定位是否齐全；
    // 不再拿「是不是最新一轮」当条件 —— 历史轮次改了什么同样值得看。
    const canOpenDiff = !!item.diffAvailable && !!item.executionId && !!item.recordId;
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
