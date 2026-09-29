/**
 * 路径相关的纯展示派生逻辑。
 *
 * 收敛原因：多处需要"从绝对路径取末级目录名作为展示名"，
 * 此前在 WorkspaceModal / chat service / SSE 处理里各写一份 split 逻辑。
 */

/** 从绝对路径中提取末级目录名（用于工作空间、工作目录的展示名） */
export function extractDirName(path?: string | null): string {
  if (!path) return '';
  const normalized = String(path).trim().replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}
