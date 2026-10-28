export type ChecklistStepStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
export interface ChecklistStep {
  stepId: string;
  seq: number;
  content: string;
  status: ChecklistStepStatus;
}
export interface ChecklistSnapshot {
  checklistId: string;
  sessionId: string;
  title: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CLOSED' | 'FAILED' | 'UNFINISHED' | 'DELETED';
  steps: ChecklistStep[];
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
export function isChecklistSnapshot(value: unknown): value is ChecklistSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as ChecklistSnapshot;
  if (!isId(snapshot.checklistId) || !isId(snapshot.sessionId) || typeof snapshot.title !== 'string'
      || !['ACTIVE', 'COMPLETED', 'CLOSED', 'FAILED', 'UNFINISHED', 'DELETED'].includes(snapshot.status)
      || !Array.isArray(snapshot.steps) || snapshot.steps.length === 0) return false;
  const ids = new Set<string>();
  const sequences = new Set<number>();
  return snapshot.steps.every(step => {
    if (!step || !isId(step.stepId) || !Number.isInteger(step.seq) || step.seq < 1
        || typeof step.content !== 'string' || !step.content.trim()
        || !['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status)
        || ids.has(step.stepId) || sequences.has(step.seq)) return false;
    ids.add(step.stepId); sequences.add(step.seq);
    return true;
  });
}
