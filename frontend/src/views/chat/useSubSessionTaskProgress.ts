import { computed, type Ref } from 'vue';
import type { SubSessionVO } from '../../types/chat';
import type { AgentEvent } from '../../types/Event';
import type { BackgroundTaskChanged } from '../../types/backgroundTask';
import { toServerId } from '../../utils/ids';
import { useBackgroundTasks } from './useBackgroundTasks';
import { useChecklist } from './useChecklist';

/** 只查询当前展开的真实子会话，收起和切换时由各数据源作废旧请求。 */
export function useSubSessionTaskProgress(session: Readonly<Ref<SubSessionVO | null>>, open: Readonly<Ref<boolean>>) {
  const sessionId = computed(() => open.value ? toServerId(session.value?.id) : null);
  const background = useBackgroundTasks(sessionId);
  const checklist = useChecklist(sessionId);

  function refresh() {
    void background.refresh();
    void checklist.refresh();
  }

  // 复用主视图的根会话事件流，不能为胶囊再开一条连接导致消息重复投递。
  function onEvent(event: AgentEvent) { checklist.onEvent(event); }
  function onTaskChanged(event: BackgroundTaskChanged) { background.onTaskChanged(event); }

  return { background, checklist, refresh, onEvent, onTaskChanged };
}

export type SubSessionTaskProgressState = ReturnType<typeof useSubSessionTaskProgress>;
