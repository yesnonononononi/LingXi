import { ref, type ComputedRef, type Ref } from 'vue';
import { useConfirm } from '../useConfirm';
import type { BranchedMenuChild, BranchedMenuItem } from '../../components/common/BranchedMenu.vue';
import type { ChatSession, WorkspaceVO } from '../../types/chat';
import { t } from '../../i18n';

/**
 * 侧边栏交互动作层：重命名编辑态、项目菜单、删除确认、BranchedMenu 选择/折叠、点击外部关闭菜单。
 *
 * <p>生命周期**不在这里**：{@link useSidebarActions} 只暴露 {@link SidebarActions.installClickOutside}
 * 与 {@link SidebarActions.disposeClickOutside}，由组件在 onMounted/onBeforeUnmount 里显式调用，
 * 便于测试环境按需挂载/卸载，也避免 composable 隐式依赖组件生命周期。</p>
 */

/** 本 composable 需要的最小 emit 契约（组件可以传入更宽的 emit）。 */
export interface SidebarActionEmit {
  (e: 'selectSession', id: string): void;
  (e: 'selectWorkspace', workspace: WorkspaceVO | null): void;
  (e: 'newSession', workspaceId?: string | number | null): void;
  (e: 'deleteWorkspace', id: string | number): void;
  (e: 'renameSession', id: string, name: string): void;
}

export interface SidebarActionsOptions {
  emit: SidebarActionEmit;
  /** 全量会话的 workspace 列表，用于「选中会话时联动选中其分组」 */
  workspaces: ComputedRef<WorkspaceVO[] | undefined>;
  expandedWorkspaces: Ref<Record<string, boolean>>;
  branchedMenuItems: ComputedRef<BranchedMenuItem[]>;
  toggleWorkspaceExpand: (wsId: string | number) => void;
  toggleFullyExpanded: (key: string) => void;
}

export interface SidebarActions {
  editingSessionId: Ref<string | null>;
  editingTitle: Ref<string>;
  activeMenuWorkspaceId: Ref<string | null>;
  handleSelectWorkspace: (ws: WorkspaceVO) => void;
  handleNewSessionInProject: (ws: WorkspaceVO, event: Event) => void;
  toggleProjectMenu: (wsId: string | number, event: Event) => void;
  handleDeleteProject: (ws: WorkspaceVO, event: Event) => Promise<void>;
  startEdit: (session: ChatSession, event: Event) => void;
  saveEdit: (session: ChatSession, event: Event) => void;
  handleBranchedSelect: (value: string, item: BranchedMenuChild | BranchedMenuItem) => void;
  handleBranchedToggle: (index: number, isOpen: boolean) => void;
  handleClickOutside: () => void;
  installClickOutside: () => void;
  disposeClickOutside: () => void;
}

export function useSidebarActions(options: SidebarActionsOptions): SidebarActions {
  const { emit, workspaces, expandedWorkspaces, branchedMenuItems, toggleWorkspaceExpand, toggleFullyExpanded } = options;

  const editingSessionId = ref<string | null>(null);
  const editingTitle = ref('');
  const activeMenuWorkspaceId = ref<string | null>(null);

  const { confirm } = useConfirm();

  const handleSelectWorkspace = (ws: WorkspaceVO) => {
    emit('selectWorkspace', ws);
    if (ws.id != null) {
      toggleWorkspaceExpand(ws.id);
    }
  };

  const handleNewSessionInProject = (ws: WorkspaceVO, event: Event) => {
    event.stopPropagation();
    emit('selectWorkspace', ws);
    emit('newSession', ws.id);
  };

  const toggleProjectMenu = (wsId: string | number, event: Event) => {
    event.stopPropagation();
    const key = String(wsId);
    activeMenuWorkspaceId.value = activeMenuWorkspaceId.value === key ? null : key;
  };

  const handleDeleteProject = async (ws: WorkspaceVO, event: Event) => {
    event.stopPropagation();
    activeMenuWorkspaceId.value = null;
    if (!ws.id) return;
    const ok = await confirm({
      title: t('chat.sidebar.deleteWorkspace'),
      content: t('chat.sidebar.deleteWorkspaceConfirm', { name: ws.name || ws.workDir || '' }),
      type: 'danger',
      confirmText: t('common.remove')
    });
    if (ok) {
      emit('deleteWorkspace', ws.id);
    }
  };

  const startEdit = (session: ChatSession, event: Event) => {
    event.stopPropagation();
    editingSessionId.value = session.id;
    editingTitle.value = session.title;
  };

  const saveEdit = (session: ChatSession, event: Event) => {
    event.stopPropagation();
    if (editingTitle.value.trim()) {
      emit('renameSession', session.id, editingTitle.value.trim());
    }
    editingSessionId.value = null;
  };

  const handleBranchedSelect = (value: string, item: BranchedMenuChild | BranchedMenuItem) => {
    if (value.startsWith('more-')) {
      toggleFullyExpanded(value.slice(5));
      return;
    }
    if (item.raw) {
      if ('title' in item.raw) {
        const session = item.raw as ChatSession;
        emit('selectSession', session.id);
        if (session.workspaceId && workspaces.value) {
          const ws = workspaces.value.find(w => String(w.id) === String(session.workspaceId));
          if (ws) emit('selectWorkspace', ws);
        }
      } else {
        const ws = item.raw as WorkspaceVO;
        handleSelectWorkspace(ws);
      }
    } else {
      emit('selectSession', value);
    }
  };

  const handleBranchedToggle = (index: number, isOpen: boolean) => {
    const item = branchedMenuItems.value[index];
    if (item && item.raw && item.raw.id) {
      expandedWorkspaces.value[String(item.raw.id)] = isOpen;
    }
  };

  const handleClickOutside = () => {
    if (activeMenuWorkspaceId.value) {
      activeMenuWorkspaceId.value = null;
    }
  };

  // 幂等：重复 install 不会重复绑定（先 remove 再 add，保证监听数量恒为 1）
  const installClickOutside = () => {
    document.removeEventListener('click', handleClickOutside);
    document.addEventListener('click', handleClickOutside);
  };

  const disposeClickOutside = () => {
    document.removeEventListener('click', handleClickOutside);
  };

  return {
    editingSessionId,
    editingTitle,
    activeMenuWorkspaceId,
    handleSelectWorkspace,
    handleNewSessionInProject,
    toggleProjectMenu,
    handleDeleteProject,
    startEdit,
    saveEdit,
    handleBranchedSelect,
    handleBranchedToggle,
    handleClickOutside,
    installClickOutside,
    disposeClickOutside
  };
}
