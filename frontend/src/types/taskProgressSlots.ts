import type {Component} from 'vue';
import type {BackgroundTasksState} from '../views/chat/useBackgroundTasks';
import type {ChecklistState} from '../views/chat/useChecklist';

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

/** 任务进度胶囊可覆盖插槽集合（缺省回落内置 BackgroundTaskPanel / ChecklistPanel）。 */
export interface TaskProgressSlotOverrides {
  readonly backgroundPanel?: Component<BackgroundPanelSlotProps>;
  readonly checklistPanel?: Component<ChecklistPanelSlotProps>;
}
