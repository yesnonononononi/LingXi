import http from './interceptor';
import type {Result} from './types';

export interface ExecutionCleanupPreview {
  executionCount: string;
  /** 文件侧是否还有要扫描的内容（孤儿正文 / .part 残留 / 上一轮没扫到的目录）。 */
  filesNeedScan: boolean;
}

export interface ExecutionCleanupResult {
  deletedCount: string;
  remainingCount: string;
}

export class ExecutionCleanupAPI {
  static preview(): Promise<Result<ExecutionCleanupPreview>> {
    return http.get<any, Result<ExecutionCleanupPreview>>('/execution/cleanup/preview');
  }

  static cleanup(): Promise<Result<ExecutionCleanupResult>> {
    return http.post<any, Result<ExecutionCleanupResult>>('/execution/cleanup');
  }
}
