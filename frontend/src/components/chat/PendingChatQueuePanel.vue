<script setup lang="ts">
import type {PendingTaskEntry} from '../../types/chat';
import type {PendingChatQueueState} from '../../types/taskProgressSlots';
import {t} from '../../i18n';

defineProps<{
  pendingQueue: PendingChatQueueState;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'edit', entry: PendingTaskEntry): void;
  (e: 'restore', entry: PendingTaskEntry): void;
}>();
</script>

<template>
  <section
    v-if="pendingQueue.snapshot.value?.entries.length"
    class="w-full rounded-2xl border px-3.5 py-2.5 text-sm backdrop-blur-md transition-colors duration-200"
    :class="isDark
      ? 'border-white/[0.09] bg-zinc-950/90 text-zinc-100 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.65)]'
      : 'border-zinc-200/85 bg-white/95 text-zinc-800 shadow-[0_6px_22px_-6px_rgba(24,24,27,0.07),0_1px_2px_rgba(24,24,27,0.04)]'"
    :aria-label="t('chat.pending.title')"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-lg"
          :class="pendingQueue.snapshot.value.paused
            ? (isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-500/10 text-amber-600')
            : (isDark ? 'bg-white/[0.08] text-zinc-300' : 'bg-zinc-100 text-zinc-600')"
          aria-hidden="true"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.5 4.5h11M2.5 8h7.5M2.5 11.5h5" />
            <circle cx="12.5" cy="10.5" r="2.2" />
          </svg>
        </span>
        <h3
          class="text-xs font-medium tracking-tight"
          :class="isDark ? 'text-zinc-300' : 'text-zinc-600'"
        >{{ t('chat.pending.count', {count: pendingQueue.snapshot.value.entries.length}) }}</h3>
      </div>
      <button
        v-if="pendingQueue.snapshot.value.paused"
        type="button"
        class="shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        :class="isDark
          ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
          : 'bg-zinc-900 text-white hover:bg-zinc-800'"
        :disabled="pendingQueue.changing.value"
        @click="pendingQueue.resume()"
      >{{ t('chat.pending.resume') }}</button>
    </div>
    <p
      v-if="pendingQueue.snapshot.value.failure || pendingQueue.error.value"
      class="mt-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 dark:text-red-400"
      role="alert"
    >
      {{ pendingQueue.error.value || pendingQueue.snapshot.value.failure }}
    </p>
    <TransitionGroup tag="ol" name="pending-item" class="mt-2 max-h-32 space-y-1 overflow-y-auto pr-0.5 scrollbar-thin">
      <li
        v-for="(entry, index) in pendingQueue.snapshot.value.entries"
        :key="entry.id"
        class="group/item flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-xs transition-colors duration-150"
        :class="isDark
          ? 'bg-white/[0.04] hover:bg-white/[0.07] text-zinc-200'
          : 'bg-zinc-100/75 hover:bg-zinc-100 text-zinc-700'"
      >
        <span
          class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md px-1 text-lx-fs-2xs font-semibold tabular-nums select-none"
          :class="isDark ? 'bg-white/10 text-zinc-300' : 'bg-zinc-200/85 text-zinc-600'"
        >{{ index + 1 }}</span>
        <span v-if="entry.attachments.length" class="flex shrink-0 items-center gap-1">
          <img
            v-for="attachment in entry.attachments.slice(0, 2)"
            :key="attachment.id"
            :src="pendingQueue.attachmentUrl(entry.id, attachment.id)"
            :alt="attachment.name"
            :title="attachment.name"
            loading="lazy"
            decoding="async"
            data-testid="pending-attachment-thumb"
            class="h-6 w-6 shrink-0 rounded-md object-cover ring-1"
            :class="isDark ? 'ring-white/15' : 'ring-zinc-200'"
          />
          <span
            v-if="entry.attachments.length > 2"
            class="text-lx-fs-2xs font-semibold tabular-nums"
            :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
          >+{{ entry.attachments.length - 2 }}</span>
        </span>
        <span class="min-w-0 flex-1 truncate leading-5" :title="entry.input">{{ entry.input }}</span>
        <span
          v-if="entry.status === 'AWAITING_CONFIRM'"
          class="inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-lx-fs-sm font-medium"
          :class="isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-500/10 text-amber-600'"
        >{{ t('chat.pending.awaitingConfirm') }}</span>
        <span
          v-if="entry.dispatching"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-lx-fs-sm font-medium"
          :class="isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-500/10 text-emerald-600'"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-current lx-live-dot" aria-hidden="true" />
          {{ t('chat.pending.sending') }}
        </span>
        <div v-else class="flex shrink-0 items-center gap-1">
          <button
            v-if="entry.status !== 'PENDING'"
            type="button"
            data-testid="pending-confirm-btn"
            class="inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :class="isDark
              ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
              : 'bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20'"
            :disabled="pendingQueue.changing.value"
            :aria-label="t('chat.pending.confirmNamed', {input: entry.input})"
            @click="pendingQueue.confirm(entry.id)"
          >{{ t('chat.pending.confirm') }}</button>
          <button
            type="button"
            data-testid="pending-edit-btn"
            class="inline-flex h-6 w-6 items-center justify-center rounded-lg transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :class="isDark
              ? 'text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-200/75 hover:text-zinc-800'"
            :title="t('chat.pending.edit')"
            :aria-label="t('chat.pending.editNamed', {input: entry.input})"
            :disabled="pendingQueue.changing.value"
            @click="emit('edit', entry)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11.333 2.667a1.414 1.414 0 0 1 2 2L5.5 12.5l-2.833.833.833-2.833 7.833-7.833Z" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="pending-cancel-btn"
            class="inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :class="isDark
              ? 'text-zinc-400 hover:bg-red-500/15 hover:text-red-300'
              : 'text-zinc-500 hover:bg-red-500/10 hover:text-red-600'"
            :aria-label="t('chat.pending.cancelNamed', {input: entry.input})"
            :disabled="pendingQueue.changing.value"
            @click="emit('restore', entry)"
          >{{ t('chat.pending.cancel') }}</button>
        </div>
      </li>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.pending-item-enter-active,
.pending-item-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pending-item-move {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pending-item-enter-from,
.pending-item-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .pending-item-enter-active,
  .pending-item-leave-active,
  .pending-item-move {
    transition: none;
  }
}
</style>
