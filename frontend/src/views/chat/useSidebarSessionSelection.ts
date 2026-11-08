import type {Ref} from 'vue';
import type {ChatSession} from '../../types/chat';

interface SidebarSessionSelectionOptions {
  sessions: Ref<ChatSession[]>;
  activeId: Ref<string | null>;
  selectSession: (id: string) => Promise<void>;
  selectSubSession: (id: string | number | null) => Promise<void>;
  closeSubPanel: () => void;
}

export function useSidebarSessionSelection(options: SidebarSessionSelectionOptions) {
  let selectionVersion = 0;
  return async (id: string) => {
    const version = ++selectionVersion;
    const owner = options.sessions.value.find(session => session.subSessions?.some(sub => String(sub.id) === id));
    if (!owner) {
      options.closeSubPanel();
      await options.selectSubSession(null);
      if (version === selectionVersion) await options.selectSession(id);
      return;
    }
    // 先切到所属会话，历史加载完成后才能把子会话详情写入同一棵树。
    if (options.activeId.value !== owner.id) await options.selectSession(owner.id);
    if (version !== selectionVersion || options.activeId.value !== owner.id) return;
    await options.selectSubSession(id);
  };
}
