import http from './interceptor';
import type { Result } from './types';
import type { BackgroundTask } from '../types/backgroundTask';

export const BackgroundTaskAPI = {
  list(sessionId: string, signal?: AbortSignal): Promise<Result<BackgroundTask[]>> {
    return http.get('/task/runtime/list', { params: { sessionId }, signal });
  },
  read(sessionId: string, taskId: string, signal?: AbortSignal): Promise<Result<BackgroundTask>> {
    return http.get(`/task/runtime/${encodeURIComponent(taskId)}`, { params: { sessionId }, signal });
  },
  stop(sessionId: string, taskId: string, signal?: AbortSignal): Promise<Result<BackgroundTask>> {
    return http.post(`/task/runtime/${encodeURIComponent(taskId)}/stop`, null, { params: { sessionId }, signal, timeout: 30_000 });
  },
};
