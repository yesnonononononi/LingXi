import http from './interceptor';
import type { Result } from './types';

export interface ExecutionCleanupPreview {
  executionCount: string;
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
