/**
 * 预览面板的差异档位：本次改动 / 最新改动 / 当前源码。
 *
 * <p>三档回答三个不同的问题，别混：「本次改动」是这条记录（清单行就是本轮末条记录）为止的
 * 累积差异；「最新改动」是这个文件在整棵会话树里最后一次改动的累积差异，可能属于别的轮次；
 * 「当前源码」是磁盘上的现状（由主进程读，不经过后端）。</p>
 *
 * <p>档位与地址拼装放在这里而不是组件里，是因为它们有对错：谁不需要请求、谁缺定位就不该出现、
 * 路径与会话标识怎么编码。写成纯函数才能被用例钉住。</p>
 */
import type {FilePreviewEditRef} from '../types/filePreview';

export const FILE_DIFF_VIEWS = ['turn', 'latest', 'source'] as const;

export type FileDiffView = typeof FILE_DIFF_VIEWS[number];

/** 拼地址需要的最小上下文：只取请求里真正参与定位的字段。 */
export interface FileDiffContext {
  edit?: FilePreviewEditRef | null;
  sessionId?: string | number | null;
  path: string;
}

/**
 * 该档位此刻能不能用。
 *
 * <p>「本次改动」要有记录定位（普通读文件没有），「最新改动」要有会话标识（没有会话就无从界定
 * 「这个文件的历史」），源码永远可用。</p>
 */
export function canUseDiffView(view: FileDiffView, context: FileDiffContext): boolean {
  if (view === 'source') return true;
  if (view === 'turn') return !!context.edit;
  return context.sessionId !== undefined && context.sessionId !== null && context.sessionId !== ''
    && !!context.path;
}

/** 档位 → 拉取地址；源码档不请求后端，返回 null（调用方据此跳过请求）。 */
export function resolveDiffEndpoint(view: FileDiffView, context: FileDiffContext,
                                     baseUrl: string): string | null {
  if (view === 'turn') {
    const edit = context.edit;
    if (!edit) return null;
    return `${baseUrl}/a/file-edits/${encodeURIComponent(edit.executionId)}/${encodeURIComponent(edit.recordId)}`;
  }
  if (view === 'latest') {
    if (!canUseDiffView('latest', context)) return null;
    const session = encodeURIComponent(String(context.sessionId));
    return `${baseUrl}/a/file-edits/latest/${session}?path=${encodeURIComponent(context.path)}`;
  }
  return null;
}

/**
 * 「最新改动」是不是就是当前打开的那条记录。
 *
 * <p>相同时界面要说明一句，否则用户切了两档看到一模一样的差异，只会以为按钮坏了。</p>
 */
export function isLatestChangeOfCurrentRecord(edit: FilePreviewEditRef | null | undefined,
                                              latest: {executionId?: string; recordId?: string} | null | undefined): boolean {
  if (!edit || !latest?.executionId || !latest.recordId) return false;
  return String(latest.executionId) === String(edit.executionId)
    && String(latest.recordId) === String(edit.recordId);
}
