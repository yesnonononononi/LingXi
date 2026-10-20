import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { Comment01Icon } from '@hugeicons/core-free-icons';
import type { BranchedMenuChild, BranchedMenuItem } from '../../components/common/BranchedMenu.vue';
import type { ChatSession } from '../../types/chat';
import { t } from '../../i18n';
import type { ProjectGroup } from './useSessionGrouping';

/**
 * 侧边栏会话可见性逻辑：截断阈值、展开态、BranchedMenu 树形数据。
 *
 * <p>与 {@link useSessionGrouping} 一样只吃 {@link Ref}，可脱离组件单测。
 * 唯一的外部耦合是 i18n {@link t}（模块级响应式单例，语言切换时会重算）。</p>
 */

/** 每组默认直接展示的会话条数；超出走「展开显示」。 */
export const SESSION_VISIBLE_LIMIT = 5;

export interface SessionVisibilitySources {
  projectGroups: ComputedRef<ProjectGroup[]>;
  unassignedSessions: ComputedRef<ChatSession[]>;
  expandedWorkspaces: Ref<Record<string, boolean>>;
}

export function useSessionVisibility(sources: SessionVisibilitySources): {
  fullyExpandedWorkspaces: Ref<Record<string, boolean>>;
  isFullyExpanded: (key: string) => boolean;
  toggleFullyExpanded: (key: string) => void;
  limitSessions: (key: string, sessions: ChatSession[]) => ChatSession[];
  buildBranchedChildren: (key: string, sessions: ChatSession[]) => BranchedMenuChild[];
  branchedMenuItems: ComputedRef<BranchedMenuItem[]>;
  branchedOpenIndices: ComputedRef<number[]>;
} {
  const { projectGroups, unassignedSessions, expandedWorkspaces } = sources;

  // 记录哪些分组被「展开显示」过（超阈值时展示全量）
  const fullyExpandedWorkspaces = ref<Record<string, boolean>>({});

  const isFullyExpanded = (key: string) => fullyExpandedWorkspaces.value[key] === true;

  const toggleFullyExpanded = (key: string) => {
    fullyExpandedWorkspaces.value[key] = !fullyExpandedWorkspaces.value[key];
  };

  // 按限制截断会话列表；超出时返回前 5 条，由「展开显示」控制全量
  const limitSessions = (key: string, sessions: ChatSession[]): ChatSession[] => {
    if (sessions.length <= SESSION_VISIBLE_LIMIT || isFullyExpanded(key)) return sessions;
    return sessions.slice(0, SESSION_VISIBLE_LIMIT);
  };

  // 计算供 BranchedMenu 消费的孩子列表：截断 + 「展开显示」伪条目
  const buildBranchedChildren = (key: string, sessions: ChatSession[]): BranchedMenuChild[] => {
    const children: BranchedMenuChild[] = limitSessions(key, sessions).map(s => ({
      value: String(s.id),
      label: s.title || t('session.newConversation'),
      icon: Comment01Icon,
      raw: s
    }));
    if (sessions.length > SESSION_VISIBLE_LIMIT) {
      children.push({
        value: `more-${key}`,
        label: isFullyExpanded(key)
          ? t('chat.sidebar.collapseDisplay')
          : t('chat.sidebar.expandDisplay', { count: sessions.length }),
        icon: undefined,
        raw: null
      });
    }
    return children;
  };

  // 构造供 BranchedMenu 树形组件消费的分支数据
  const branchedMenuItems = computed<BranchedMenuItem[]>(() => {
    const items: BranchedMenuItem[] = [];

    for (const group of projectGroups.value) {
      items.push({
        label: group.workspace.name || group.workspace.workDir || t('session.workspace'),
        value: `ws-${group.workspace.id}`,
        raw: group.workspace,
        children: buildBranchedChildren(String(group.workspace.id), group.sessions)
      });
    }

    if (unassignedSessions.value.length > 0) {
      items.push({
        label: t('chat.sidebar.history'),
        value: 'ws-unassigned',
        raw: null,
        children: buildBranchedChildren('ws-unassigned', unassignedSessions.value)
      });
    }

    return items;
  });

  // 计算当前展开的区段索引：workspace 组看 expandedWorkspaces[`${id}`] 是否为 false，
  // 未分组组（无 raw.id）恒展开。
  const branchedOpenIndices = computed<number[]>(() => {
    const indices: number[] = [];
    branchedMenuItems.value.forEach((item, idx) => {
      if (item.raw && item.raw.id) {
        if (expandedWorkspaces.value[String(item.raw.id)] !== false) {
          indices.push(idx);
        }
      } else {
        indices.push(idx);
      }
    });
    return indices;
  });

  return {
    fullyExpandedWorkspaces,
    isFullyExpanded,
    toggleFullyExpanded,
    limitSessions,
    buildBranchedChildren,
    branchedMenuItems,
    branchedOpenIndices
  };
}
