import type {Component} from 'vue';
import type {PendingTaskEntry} from './chat';
import type {BackgroundTasksState} from '../views/chat/useBackgroundTasks';
import type {ChecklistState} from '../views/chat/useChecklist';
import type {usePendingChatQueue} from '../views/chat/usePendingChatQueue';

export type PendingChatQueueState = ReturnType<typeof usePendingChatQueue>;

/** 后台任务胶囊与面板插槽统一 props。 */
export interface BackgroundPanelSlotProps {
  readonly feed: BackgroundTasksState;
  readonly isDark?: boolean;
  readonly embedded?: boolean;
  readonly expanded?: boolean;
}

/** 任务清单胶囊与面板插槽统一 props。 */
export interface ChecklistPanelSlotProps {
  readonly feed: ChecklistState;
  readonly expanded: boolean;
  readonly executing: boolean;
  readonly isDark?: boolean;
}

/** 待发送队列（pendingChat）面板插槽统一 props。 */
export interface PendingQueuePanelSlotProps {
  readonly pendingQueue: PendingChatQueueState;
  readonly isDark?: boolean;
  readonly onEdit?: (entry: PendingTaskEntry) => void;
  readonly onRestore?: (entry: PendingTaskEntry) => void;
}

/** 任务进度胶囊与待发送队列可覆盖插槽集合（缺省回落内置实现）。 */
export interface TaskProgressSlotOverrides {
  readonly backgroundPanel?: Component<BackgroundPanelSlotProps>;
  readonly checklistPanel?: Component<ChecklistPanelSlotProps>;
  readonly pendingQueuePanel?: Component<PendingQueuePanelSlotProps>;
}
