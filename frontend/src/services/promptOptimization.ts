import http from './interceptor';
import type { Result } from './types';

export class PromptOptimizationAPI {
  static optimize(prompt: string, modelId?: string | number, signal?: AbortSignal): Promise<Result<string>> {
    return http.post<unknown, Result<string>>('/model/optimize-prompt', { prompt, modelId }, {
      timeout: 70_000,
      signal,
    });
  }
}
