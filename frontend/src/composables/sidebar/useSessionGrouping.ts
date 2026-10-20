import { computed, type ComputedRef, type Ref } from 'vue';
import type { ChatSession, WorkspaceVO } from '../../types/chat';

/**
 * 侧边栏会话分组逻辑（纯计算，不依赖 emit / 生命周期）。
 *
 * <p>职责单一：回答「哪些会话归属哪个 workspace」「哪些会话游离在外」「哪个 workspace 处于激活态」。
 * 只接收 {@link Ref} 而非 props 对象，便于脱离组件独立驱动与单测；
 * 调用方（Sidebar.vue）用 <code>computed(() => props.xxx)</code> 包一层以保持响应性。</p>
 *
 * <p><b>谓词语义说明（有意不统一，勿"顺手合并"）</b>：本 composable 中的
 * {@link sessionBelongsToWorkspace} 要求 workDir 在 workspaces 中唯一（sameDirCount === 1）。
 * 而 Sidebar.vue 的 watch(activeSessionId) 内联谓词<strong>不做</strong>唯一性判断，
 * 且把「既无 workspaceId 又无 workDir」的会话计入当前组 —— 两者是既有行为差异，
 * 由主理人裁决本阶段保持原样，统一语义须另开任务并先补可区分两种语义的用例。</p>
 */

/** 已按 workspace 归组的会话集合。 */
export interface ProjectGroup {
  workspace: WorkspaceVO;
  sessions: ChatSession[];
}

export interface SessionGroupingSources {
  sessions: Ref<ChatSession[]>;
  workspaces: Ref<WorkspaceVO[] | undefined>;
  filterQuery: Ref<string>;
  isSortAsc: Ref<boolean>;
}

/** 会话有显式 workspaceId（非 null / 非 undefined / 非 activeId 空白）。 */
const hasBoundWorkspace = (session: ChatSession): boolean =>
  session.workspaceId !== undefined &&
  session.workspaceId !== null &&
  String(session.workspaceId).trim() !== '';

/** 计算 workDir 相同的 workspace 数量；未设置 workDir 时为 0。 */
const countSameDir = (workDir: string | null | undefined, wsList: WorkspaceVO[]): number =>
  workDir ? wsList.filter(w => w.workDir && w.workDir.trim() === workDir.trim()).length : 0;

/**
 * 唯一性感知的归属谓词：projectGroups / unassignedSessions / isWorkspaceActive 共用。
 *
 * <p>规则与会话视图现状一致（见 Sidebar.vue 原实现）：</p>
 * <ul>
 *   <li>有 workspaceId → 精确 String 相等；</li>
 *   <li>无 workspaceId → workDir 相等<strong>且</strong>该 workDir 在 wsList 中唯一。</li>
 * </ul>
 */
export const sessionBelongsToWorkspace = (
  session: ChatSession,
  ws: WorkspaceVO,
  wsList: WorkspaceVO[]
): boolean => {
  if (hasBoundWorkspace(session)) {
    return String(session.workspaceId) === String(ws.id);
  }
  if (session.workDir && ws.workDir && session.workDir.trim() === ws.workDir.trim()) {
    return countSameDir(session.workDir, wsList) === 1;
  }
  return false;
};

export function useSessionGrouping(sources: SessionGroupingSources): {
  projectGroups: ComputedRef<ProjectGroup[]>;
  unassignedSessions: ComputedRef<ChatSession[]>;
  isWorkspaceActive: (
    ws: WorkspaceVO,
    activeWorkspaceId: string | number | null | undefined,
    activeSessionId: string | null
  ) => boolean;
} {
  const { sessions, workspaces, filterQuery, isSortAsc } = sources;

  // 按照后端 workspace 的 ID（及兼容 workDir）收敛会话
  const projectGroups = computed<ProjectGroup[]>(() => {
    const wsList = [...(workspaces.value || [])];
    if (isSortAsc.value) {
      wsList.sort((a, b) => (a.name || a.workDir || '').localeCompare(b.name || b.workDir || ''));
    }
    const groups: ProjectGroup[] = [];

    for (const ws of wsList) {
      if (filterQuery.value.trim()) {
        const q = filterQuery.value.toLowerCase();
        const matchName = (ws.name || '').toLowerCase().includes(q);
        const matchDir = (ws.workDir || '').toLowerCase().includes(q);
        if (!matchName && !matchDir) continue;
      }

      const matchedSessions = sessions.value.filter(s => sessionBelongsToWorkspace(s, ws, wsList));
      groups.push({ workspace: ws, sessions: matchedSessions });
    }

    return groups;
  });

  // 未绑定到已注册工作空间的会话
  const unassignedSessions = computed<ChatSession[]>(() => {
    const wsList = workspaces.value || [];
    return sessions.value.filter(s => {
      if (hasBoundWorkspace(s)) {
        return !wsList.some(ws => String(ws.id) === String(s.workspaceId));
      }
      if (s.workDir) {
        // workDir 唯一时视为已归属，不算游离
        if (countSameDir(s.workDir, wsList) === 1) return false;
      }
      return true;
    });
  });

  /**
   * 判定 workspace 是否处于激活态：优先比 activeWorkspaceId；
   * 否则由 activeSessionId 反查会话，再按归属谓词判断。
   * 显式传值而非闭包读 props，纯函数可逐条断言。
   */
  const isWorkspaceActive = (
    ws: WorkspaceVO,
    activeWorkspaceId: string | number | null | undefined,
    activeSessionId: string | null
  ): boolean => {
    if (activeWorkspaceId !== undefined && activeWorkspaceId !== null && String(activeWorkspaceId) === String(ws.id)) {
      return true;
    }
    if (activeSessionId) {
      const session = sessions.value.find(s => s.id === activeSessionId);
      if (session) {
        if (hasBoundWorkspace(session)) {
          return String(session.workspaceId) === String(ws.id);
        }
        if (session.workDir && ws.workDir && session.workDir === ws.workDir) {
          return countSameDir(session.workDir, wsList(workspaces.value)) === 1;
        }
      }
    }
    return false;
  };

  return { projectGroups, unassignedSessions, isWorkspaceActive };
}

/** isWorkspaceActive 反查会话后按原实现比较 workDir 时的 workspace 列表来源。 */
function wsList(workspaces: WorkspaceVO[] | undefined): WorkspaceVO[] {
  return workspaces || [];
}
