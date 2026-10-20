import { ref, watch, type ComputedRef, type Ref } from 'vue';
import type { ChatSession, WorkspaceVO } from '../../types/chat';

/**
 * 侧边栏工作空间展开态：`expandedWorkspaces`（折叠/展开）与 `fullyExpandedWorkspaces`
 * （超阈值时「展开显示」全量）以及驱动它们的两个 watch。
 *
 * <p>两个 ref 放在一起，是因为下面的 activeSessionId watch 会**同时**写它们；
 * 拆到两个 composable 会引入初始化顺序依赖（immediate watch 在 setup 期同步执行）。
 * <b>注意：watch 内两个内联谓词（isMatch 与 sessions.filter）语义不同，禁止合并</b>——
 * 前者要求 workspaceId/workDir 严格相等，后者对 workspaceId 做 trim 且把「无 workspaceId 且无 workDir」
 * 的会话视为通用。合并会改变归属行为（见 .lingxi/plan/plugin-frontend-milestones.md 裁决 R4）。</p>
 */

export interface WorkspaceExpansionOptions {
  workspaces: ComputedRef<WorkspaceVO[] | undefined>;
  activeSessionId: ComputedRef<string | null>;
  sessions: ComputedRef<ChatSession[]>;
  /** 每组默认展示条数，超过则该组需要「展开显示」；默认 5 */
  sessionVisibleLimit?: number;
}

export function useWorkspaceExpansion(options: WorkspaceExpansionOptions): {
  expandedWorkspaces: Ref<Record<string, boolean>>;
  fullyExpandedWorkspaces: Ref<Record<string, boolean>>;
  toggleWorkspaceExpand: (wsId: string | number) => void;
} {
  const { workspaces, activeSessionId, sessions, sessionVisibleLimit = 5 } = options;

  const expandedWorkspaces = ref<Record<string, boolean>>({});
  const fullyExpandedWorkspaces = ref<Record<string, boolean>>({});

  const toggleWorkspaceExpand = (wsId: string | number) => {
    const key = String(wsId);
    expandedWorkspaces.value[key] = !expandedWorkspaces.value[key];
  };

  // 默认不展开所有工作空间
  watch(
    () => workspaces.value,
    (list) => {
      if (list) {
        for (const ws of list) {
          if (ws.id && expandedWorkspaces.value[String(ws.id)] === undefined) {
            expandedWorkspaces.value[String(ws.id)] = false;
          }
        }
      }
    },
    { immediate: true }
  );

  // 当激活某个会话时，自动展开对应的工作空间
  watch(
    () => activeSessionId.value,
    (sessionId) => {
      if (!sessionId) return;
      const session = sessions.value.find(s => s.id === sessionId);
      if (session && workspaces.value) {
        for (const ws of workspaces.value) {
          const isMatch = (session.workspaceId !== undefined && session.workspaceId !== null && String(session.workspaceId) === String(ws.id)) ||
            (!session.workspaceId && session.workDir && ws.workDir && session.workDir === ws.workDir);
          if (isMatch && ws.id) {
            expandedWorkspaces.value[String(ws.id)] = true;
            // 激活会话可能排在第 5 条之后，完整展开保证可见
            const key = String(ws.id);
            const inGroup = sessions.value.filter(s => {
              if (s.workspaceId !== undefined && s.workspaceId !== null && String(s.workspaceId).trim() !== '') {
                return String(s.workspaceId) === String(ws.id);
              }
              return !s.workspaceId && !s.workDir ? true : s.workDir && ws.workDir && s.workDir.trim() === ws.workDir.trim();
            });
          const idx = inGroup.findIndex(s => s.id === sessionId);
          if (idx >= sessionVisibleLimit) {
            fullyExpandedWorkspaces.value[key] = true;
          }
            break;
          }
        }
      }
    },
    { immediate: true }
  );

  return { expandedWorkspaces, fullyExpandedWorkspaces, toggleWorkspaceExpand };
}
