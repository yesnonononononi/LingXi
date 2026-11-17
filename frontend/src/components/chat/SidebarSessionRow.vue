<script setup lang="ts">
/**
 * 侧栏的一行会话（亮色自绘列表用）。
 *
 * <p>抽出来的原因：这段行模板原本在 SidebarWorkspaceTree 里复制了两份（工作区组内、历史分组），
 * 加置顶分区会变成三份，再加图钉按钮就是三份各自演化的 UI。行内容与子代理分支属同一个视觉单元，
 * 因此分支折叠也留在本组件里，父组件只提供状态与回调。</p>
 *
 * <p>暗色主题不走本组件（它是 BranchedMenu 的托管行），但两边的动作是同一条 emit 链，
 * 见 {@code SidebarTreeActions.onTogglePin}。</p>
 */
import type {ChatSession} from '../../types/chat';
import {t} from '../../i18n';
import {isSessionActive} from '../../utils/session';
import SessionStateIndicator from './SessionStateIndicator.vue';
import SessionPinButton from './SessionPinButton.vue';
import SidebarSubSessions from './SidebarSubSessions.vue';
import CollapseTransition from '../common/CollapseTransition.vue';

defineProps<{
  session: ChatSession;
  activeId: string | null;
  activeSubSessionId?: string | null;
  editingSessionId: string | null;
  isBranchExpanded: (id: string) => boolean;
  toggleBranch: (id: string) => void;
  onSelect: (id: string) => void;
  onStartEdit: (session: ChatSession, event: Event) => void;
  onSaveEdit: (session: ChatSession, event: Event) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}>();

// 重命名输入框的绑定值是父组件的 Ref：模板里 ref 会被自动解包，所以只能走 v-model 传值与回写，
// 直接把 Ref 当 prop 传会变成一个字符串快照 —— 输入框能显示，但改不动（线上表现为重命名失效）。
const editingTitle = defineModel<string>('editingTitle', {required: true});
</script>

<template>
  <div
    @click="onSelect(session.id)"
    :class="[
      'group/session relative flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
      activeId === session.id
        ? 'bg-blue-50 text-blue-600 font-medium'
        : 'hover:bg-zinc-100/70 text-zinc-600 hover:text-zinc-900'
    ]"
  >
    <button
      v-if="session.subSessions?.length"
      type="button"
      data-testid="toggle-sub-sessions"
      :aria-label="session.title"
      :aria-expanded="isBranchExpanded(session.id)"
      class="flex h-4 w-3.5 shrink-0 items-center justify-center rounded cursor-pointer hover:bg-zinc-200"
      @click.stop="toggleBranch(session.id)"
    >
      <svg
        class="h-3 w-3 transition-transform duration-200 motion-reduce:transition-none"
        :class="isBranchExpanded(session.id) ? 'rotate-90' : ''"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"
      ><path d="m9 5 7 7-7 7" /></svg>
    </button>
    <svg v-else class="w-3.5 h-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
    </svg>

    <div class="flex-1 truncate">
      <input
        v-if="editingSessionId === session.id"
        v-model="editingTitle"
        @blur="onSaveEdit(session, $event)"
        @keyup.enter="onSaveEdit(session, $event)"
        class="w-full bg-transparent border-b border-blue-500 outline-none text-xs px-0.5 text-inherit"
        autoFocus
      />
      <span v-else class="block truncate" :title="session.title || t('session.newConversation')">{{ session.title || t('session.newConversation') }}</span>
    </div>

    <SessionStateIndicator :session="session" :active="String(session.id) === activeId" />
    <div v-if="editingSessionId !== session.id" class="hidden group-hover/session:flex items-center gap-1 opacity-70 shrink-0">
      <SessionPinButton :pinned="session.isPinned === true" @toggle="onTogglePin(session.id)" />
      <button @click="onStartEdit(session, $event)" class="p-0.5 hover:text-blue-500 transition cursor-pointer" :title="t('chat.sidebar.rename')">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
      <button
        :disabled="isSessionActive(session, { activeSessionId: activeId })"
        @click.stop="isSessionActive(session, { activeSessionId: activeId }) ? undefined : onDelete(session.id)"
        :class="[
          'p-0.5 transition',
          isSessionActive(session, { activeSessionId: activeId })
            ? 'opacity-30 cursor-not-allowed text-zinc-400'
            : 'hover:text-red-500 cursor-pointer'
        ]"
        :title="isSessionActive(session, { activeSessionId: activeId }) ? t('chat.sidebar.deleteSessionActiveBlocked') : t('common.remove')"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  </div>

  <CollapseTransition>
    <SidebarSubSessions
      v-if="isBranchExpanded(session.id)"
      :sessions="session.subSessions"
      :activeId="activeSubSessionId"
      @select="onSelect"
    />
  </CollapseTransition>
</template>
