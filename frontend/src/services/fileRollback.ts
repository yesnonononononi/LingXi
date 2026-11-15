/**
 * 文件回滚接口：按基线回填一次执行改过的文件。
 *
 * <p>两段式是契约的一部分：先 {@code preview} 拿到逐文件结论，用户确认后才 {@code rollback}。
 * 合并成一个「点了就写盘」的调用会让跳过的原因永远没机会被看见。</p>
 *
 * <p>{@code executionId} 一律按字符串透传：雪花 ID 超出 {@code Number.MAX_SAFE_INTEGER}，
 * 走 {@code Number()} 会静默改掉末位，回滚就落到别的执行上。</p>
 */
import http from './interceptor';
import type {Result} from './types';

export type FileRollbackAction = 'RESTORE' | 'DELETE' | 'SKIP';

export interface FileRollbackItem {
  filePath: string;
  action: FileRollbackAction;
  /** 跳过原因；能执行时为 null。 */
  reason?: string | null;
  /** 基线原文；只有 RESTORE 才有。 */
  baseline?: string | null;
  recordId: string;
}

export interface FileRollbackPlan {
  executionId: string;
  items: FileRollbackItem[];
}

export interface FileRollbackOutcome {
  filePath: string;
  action: FileRollbackAction;
  success: boolean;
  message?: string | null;
  backupPath?: string | null;
}

export interface FileRollbackResult {
  executionId: string;
  outcomes: FileRollbackOutcome[];
}

export class FileRollbackAPI {

  /** 只读预览：能回滚什么、跳过什么、为什么跳过。 */
  static async preview(executionId: string): Promise<Result<FileRollbackPlan>> {
    return http.post<any, Result<FileRollbackPlan>>(
      `/a/file-edits/rollback/preview/${encodeURIComponent(executionId)}`);
  }

  /** 按基线回填确认过的文件；后端会重新算一遍计划再动手。 */
  static async rollback(executionId: string, confirmedPaths: string[]): Promise<Result<FileRollbackResult>> {
    return http.post<any, Result<FileRollbackResult>>(
      `/a/file-edits/rollback/${encodeURIComponent(executionId)}`, {confirmedPaths});
  }
}
