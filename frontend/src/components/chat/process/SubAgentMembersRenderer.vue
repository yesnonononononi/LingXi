<script setup lang="ts">
/**
 * 子代理协同条 renderer：成员行 + 状态色点 + 「结果以邮件送达」提示。
 *
 * <p>根元素与 class 与原 `ProcessDetails.vue` 的 sub_agent 分支逐字一致。</p>
 *
 * <p>成员状态一律以**子会话权威态**为准（`asyncSubSessionStatus`），不得因为工具 `success`
 * 就显示成已完成 —— 这是 AC-5 的核心误判点。</p>
 */
import { computed } from 'vue';
import type { ImageProcessItem } from '../../../utils/readImageTools';
import type { SubSessionVO, ToolCallTrace } from '../../../types/chat';
import { asyncSubSessionStatus, isAsyncDelegation, subItemStatusDotClass } from '../../../utils/asyncDelegation';
import type { SubItemStatus } from '../../../types/chat';
import { extractSubAgentParams } from '../../../utils/toolMeta';
import { t } from '../../../i18n';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  subSessions?: SubSessionVO[];
}>();

const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();

const members = computed<ToolCallTrace[]>(() => props.item.subAgents ?? []);

/** 成员状态：子会话存在时以子会话为准，否则回落工具调用态。 */
const memberStatus = (tool: ToolCallTrace): SubItemStatus => {
  const params = extractSubAgentParams(tool);
  const agentId = params.agentId ?? tool.subAgentId;
  const subSessionId = tool.subSessionId ?? params.subSessionId;
  const matched = (subSessionId
    ? props.subSessions?.find(item => String(item.id) === String(subSessionId))
    : undefined)
    || (agentId ? props.subSessions?.find(item => String(item.agentId) === String(agentId)) : undefined);
  return asyncSubSessionStatus(matched, tool);
};

const memberDotClass = (tool: ToolCallTrace): string => subItemStatusDotClass(memberStatus(tool));

/** 成员行 title：协作式委派说明结果以邮件送达（阻塞式保持原提示）。 */
const memberTitle = (tool: ToolCallTrace, index: number): string => {
  const name = tool.subAgentName || `Agent #${tool.displayIndex || index + 1}`;
  return isAsyncDelegation(tool)
    ? t('chat.message.asyncDelegationTip', { name })
    : t('chat.message.viewSubSessionTip', { name });
};

const openMember = (tool: ToolCallTrace): void => {
  emit('selectSubSession', tool.subSessionId || tool.id);
};
</script>

<template>
  <!-- 3. SubAgent 子代理多会话协同指示条 -->
  <div
    v-if="members.length"
    :class="[
      'w-full min-w-0 px-3.5 py-2.5 rounded-2xl border flex items-center justify-between gap-3 text-xs select-none transition-colors overflow-hidden',
      isDark ? 'bg-[#141b29]/70 border-[#222d42] text-zinc-200' : 'bg-blue-50/70 border-blue-200/80 text-blue-900'
    ]"
  >
    <!-- 左侧信息区：固定尺寸，禁止压缩，文案不折行 -->
    <div class="flex items-center gap-2.5 shrink-0 select-none">
      <div class="w-6 h-6 rounded-lg bg-linear-to-tr from-blue-500 to-indigo-600 flex items-center justify-center text-white shrink-0 shadow-2xs">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      </div>
      <div class="flex flex-col shrink-0">
        <div class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="font-medium">{{ t('chat.message.teamCollab') }}</span>
          <span :class="['px-1.5 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap', isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700']">
            {{ t('chat.message.membersWorking', { count: members.length }) }}
          </span>
        </div>
        <p class="text-[11px] text-zinc-400 whitespace-nowrap">{{ t('chat.message.trajectoryOnRight') }}</p>
      </div>
    </div>

    <!-- 右侧成员列表：占用剩余空间，横向超出滚动，不溢出卡片 -->
    <div class="flex-1 min-w-0 flex items-center justify-end gap-1.5 overflow-x-auto scrollbar-thin py-0.5">
      <button
        v-for="(tc, idx) in members"
        :key="tc.id || idx"
        @click="openMember(tc)"
        :class="[
          'px-2.5 py-1 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer shrink-0',
          isDark ? 'border-blue-500/30 bg-blue-600/15 hover:bg-blue-600/25 text-blue-300' : 'border-blue-200 bg-white hover:bg-blue-100 text-blue-700'
        ]"
        :title="memberTitle(tc, idx)"
      >
        <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="memberDotClass(tc)"></span>
        <span class="truncate max-w-28">{{ tc.subAgentName || `Agent #${tc.displayIndex || idx + 1}` }}</span>
        <span class="text-[10px] opacity-60 shrink-0">#{{ tc.displayIndex ?? (idx + 1) }}</span>
      </button>
    </div>
  </div>
</template>
