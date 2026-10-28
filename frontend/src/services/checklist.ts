import http from './interceptor';
import type { Result } from './types';
import type { ChecklistSnapshot } from '../types/checklist';

export const ChecklistAPI = {
  current(sessionId: string, signal?: AbortSignal): Promise<Result<ChecklistSnapshot | null>> {
    return http.get('/checklist/current', { params: { sessionId }, signal });
  },
};
