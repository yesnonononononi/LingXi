export const BACKGROUND_TASK_CHANGED = 'BACKGROUND_TASK_CHANGED';
export const TASK_STATUSES = ['PENDING', 'RUNNING', 'FAILED', 'SUCCESS', 'TIMEOUT', 'CANCELLED', 'LOST'] as const;
export type BackgroundTaskStatus = typeof TASK_STATUSES[number];
export interface BackgroundTask {
  id: string;
  sessionId: string;
  turnId: string;
  command: string;
  intention?: string | null;
  status: BackgroundTaskStatus;
  output?: string | null;
  exitCode?: number | null;
  truncated: boolean;
  createAt: string;
  completeAt?: string | null;
}
export interface BackgroundTaskChanged {
  rootSessionId: string;
  sessionId: string;
  taskId: string;
  status: BackgroundTaskStatus;
}
const isId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
export function isBackgroundTaskChanged(value: unknown): value is BackgroundTaskChanged {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return isId(event.rootSessionId) && isId(event.sessionId) && isId(event.taskId)
    && TASK_STATUSES.includes(event.status as BackgroundTaskStatus);
}
export function isBackgroundTask(value: unknown): value is BackgroundTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return isId(task.id) && isId(task.sessionId) && isId(task.turnId) && typeof task.command === 'string'
    && typeof task.createAt === 'string' && TASK_STATUSES.includes(task.status as BackgroundTaskStatus)
    && (task.intention == null || typeof task.intention === 'string')
    && (task.output == null || typeof task.output === 'string') && typeof task.truncated === 'boolean'
    && (task.exitCode == null || (typeof task.exitCode === 'number' && Number.isInteger(task.exitCode)))
    && (task.completeAt == null || typeof task.completeAt === 'string');
}
export const isTaskActive = (task: BackgroundTask): boolean => task.status === 'PENDING' || task.status === 'RUNNING';
