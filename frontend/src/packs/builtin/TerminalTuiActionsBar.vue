<script setup lang="ts">
import {ref} from 'vue';
import type {ChatMessageExecStatusMeta} from '../../types/chatMessageSlots';
import type {ChatMessage, ChatTurn} from '../../types/chat';
import type {TokenInfo} from '../../types/Event';
import {t} from '../../i18n';

const props = defineProps<{
  message: ChatMessage;
  isDark: boolean;
  isMessageCompleted: boolean;
  execStatusMeta: ChatMessageExecStatusMeta | null;
  showExecutionMeta: boolean;
  tokenUsage: TokenInfo | null;
  turn: ChatTurn | null;
  displayDuration: string;
  displayTime: string;
  copied: boolean;
  copyContent: () => void;
  copyText: (text: string) => void;
}>();

const showTokenDetail = ref(false);
</script>

<!--
  终端状态行（内置 Slot 极限）：正文下方那条「一行遥测」。
  动作（copy）、退出码、耗时、token、模型都用 `·` 分隔的等宽文本表达，
  点 token 才展开明细——默认不抢正文的注意力。
-->
<template>
  <div class="tui-actions w-full">
    <div class="tui-line flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <button type="button" class="tui-act" :data-active="props.copied ? 'true' : 'false'" @click="props.copyContent">
          <svg v-if="props.copied" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="9" y="9" width="13" height="13" rx="1" />
            <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
          </svg>
          <span>{{ props.copied ? t('common.copied') : 'copy' }}</span>
        </button>

        <span v-if="props.execStatusMeta" class="tui-sep" aria-hidden="true">·</span>
        <span
          v-if="props.execStatusMeta"
          class="tui-field"
          :style="{ color: props.execStatusMeta.failed ? 'var(--lx-danger)' : 'var(--lx-success)' }"
        >{{ props.execStatusMeta.text }}</span>

        <template v-if="props.showExecutionMeta && props.displayDuration">
          <span class="tui-sep" aria-hidden="true">·</span>
          <span class="tui-field tabular-nums">{{ props.displayDuration }}</span>
        </template>

        <template v-if="props.tokenUsage?.totalTokenCount">
          <span class="tui-sep" aria-hidden="true">·</span>
          <button type="button" class="tui-field tui-field--btn tabular-nums" :data-active="showTokenDetail ? 'true' : 'false'" @click="showTokenDetail = !showTokenDetail">
            {{ props.tokenUsage.totalTokenCount }} tok
          </button>
        </template>

        <template v-if="props.turn?.modelName">
          <span class="tui-sep" aria-hidden="true">·</span>
          <span class="tui-field truncate max-w-[12rem]">{{ props.turn.modelName }}</span>
        </template>
      </div>

      <span class="tui-field tui-field--faint tabular-nums">{{ props.displayTime }}</span>
    </div>

    <div v-if="showTokenDetail && props.tokenUsage" class="tui-detail">
      <span>in <b>{{ props.tokenUsage.inputTokenCount ?? 0 }}</b></span>
      <span>out <b>{{ props.tokenUsage.outputTokenCount ?? 0 }}</b></span>
      <span v-if="props.tokenUsage.cacheTokens">cache <b :style="{ color: 'var(--lx-success)' }">{{ props.tokenUsage.cacheTokens }}</b></span>
      <span v-if="props.tokenUsage.reasoningTokens">think <b :style="{ color: 'var(--lx-info)' }">{{ props.tokenUsage.reasoningTokens }}</b></span>
    </div>
  </div>
</template>

<style scoped>
.tui-actions {
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--lx-text-faint);
}
.tui-line { padding: 1px 2px; }

.tui-act {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: 10px;
  color: var(--lx-text-muted);
  background: transparent;
  border: 1px solid var(--lx-border-subtle);
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.tui-act:hover { color: var(--lx-accent); border-color: var(--lx-accent); }
.tui-act[data-active='true'] { color: var(--lx-success); border-color: var(--lx-success); }

.tui-sep { opacity: 0.4; }
.tui-field { white-space: nowrap; }
.tui-field--faint { color: var(--lx-text-faint); }
.tui-field--btn {
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  cursor: pointer;
}
.tui-field--btn:hover { color: var(--lx-accent); }
.tui-field--btn[data-active='true'] { color: var(--lx-accent); }

.tui-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 3px 2px 1px;
  border-top: 1px solid var(--lx-border-subtle);
  margin-top: 2px;
  color: var(--lx-text-muted);
}
.tui-detail b { color: var(--lx-text-primary); font-weight: 500; }
</style>
