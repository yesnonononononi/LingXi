<script setup lang="ts">
import { ref } from 'vue';
import type { ChatSession } from '../../types/chat';

const props = defineProps<{
  sessions: ChatSession[];
  activeSessionId: string | null;
  isCollapsed: boolean;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectSession', id: string): void;
  (e: 'newSession'): void;
  (e: 'deleteSession', id: string): void;
  (e: 'renameSession', id: string, name: string): void;
  (e: 'toggleCollapse'): void;
  (e: 'openSettings'): void;
  (e: 'logout'): void;
}>();

const editingSessionId = ref<string | null>(null);
const editingTitle = ref('');

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
</script>

<template>
  <aside
    :class="[
      'h-full flex flex-col transition-all duration-300 z-30 select-none border-r',
      isCollapsed ? 'w-16' : 'w-64',
      isDark ? 'bg-[#121722] border-[#273043] text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'
    ]"
  >
    <!-- Header: Logo & New Chat -->
    <div class="p-3 flex flex-col gap-3 border-b border-transparent">
      <div class="flex items-center justify-between">
        <div v-if="!isCollapsed" class="flex items-center gap-2.5 px-2 py-1">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-tr from-[#4d6bfe] to-indigo-500 flex items-center justify-center text-white font-bold shadow-md text-sm">
            灵
          </div>
          <span class="font-semibold text-base tracking-wide bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            灵犀 Agent
          </span>
        </div>
        <button
          @click="emit('toggleCollapse')"
          title="收起/展开侧边栏"
          :class="[
            'p-2 rounded-lg hover:bg-gray-500/15 transition text-gray-400 hover:text-gray-200',
            isCollapsed ? 'mx-auto' : ''
          ]"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
          </svg>
        </button>
      </div>

      <!-- New Chat Button -->
      <button
        @click="emit('newSession')"
        :class="[
          'flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl transition font-medium text-sm shadow-sm',
          isDark 
            ? 'bg-[#1e2638] hover:bg-[#27324a] text-blue-400 border border-[#2d3a54]' 
            : 'bg-white hover:bg-gray-100 text-blue-600 border border-gray-200',
          isCollapsed ? 'p-2.5' : 'w-full'
        ]"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span v-if="!isCollapsed">发起新对话</span>
      </button>
    </div>

    <!-- History Session List -->
    <div class="flex-1 overflow-y-auto px-2 py-3 space-y-1.5 scrollbar-thin">
      <div v-if="!isCollapsed" class="px-2 pb-1.5 text-xs font-semibold text-gray-500 tracking-wider">
        最近对话
      </div>
      
      <div
        v-for="session in sessions"
        :key="session.id"
        @click="emit('selectSession', session.id)"
        :class="[
          'group relative flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer text-sm transition',
          activeSessionId === session.id
            ? (isDark ? 'bg-[#1e2638] text-blue-400 font-medium' : 'bg-blue-50 text-blue-600 font-medium')
            : (isDark ? 'hover:bg-[#1a202c] text-gray-400 hover:text-gray-200' : 'hover:bg-gray-100 text-gray-600')
        ]"
      >
        <!-- Icon -->
        <svg class="w-4 h-4 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>

        <!-- Title / Input field -->
        <div v-if="!isCollapsed" class="flex-1 truncate">
          <input
            v-if="editingSessionId === session.id"
            v-model="editingTitle"
            @blur="saveEdit(session, $event)"
            @keyup.enter="saveEdit(session, $event)"
            class="w-full bg-transparent border-b border-blue-500 outline-none text-xs px-1 text-white"
            autoFocus
          />
          <span v-else class="block truncate">{{ session.title || '新对话' }}</span>
        </div>

        <!-- Action Controls -->
        <div v-if="!isCollapsed && editingSessionId !== session.id" class="hidden group-hover:flex items-center gap-1 opacity-80">
          <button @click="startEdit(session, $event)" class="p-1 hover:text-blue-400 transition" title="重命名">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button @click.stop="emit('deleteSession', session.id)" class="p-1 hover:text-red-400 transition" title="删除">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- User Profile & Footer Settings -->
    <div :class="['p-3 border-t', isDark ? 'border-[#273043]' : 'border-gray-200']">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5 truncate">
          <div class="w-8 h-8 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white text-xs shrink-0 shadow">
            User
          </div>
          <div v-if="!isCollapsed" class="truncate">
            <div class="text-xs font-semibold truncate">开发者账号</div>
            <div class="text-[10px] text-gray-500 truncate">Agent Console</div>
          </div>
        </div>
        <div v-if="!isCollapsed" class="flex items-center gap-1">
          <button @click="emit('openSettings')" class="p-1.5 rounded-lg hover:bg-gray-500/15 text-gray-400 hover:text-gray-200 transition" title="设置">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button @click="emit('logout')" class="p-1.5 rounded-lg hover:bg-red-500/15 text-gray-400 hover:text-red-400 transition" title="退出登录">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>
