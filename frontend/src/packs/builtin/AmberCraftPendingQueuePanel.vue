<script setup lang="ts">
import type {PendingTaskEntry} from '../../types/chat';
import type {PendingChatQueueState} from '../../types/taskProgressSlots';
import {t} from '../../i18n';

defineProps<{ pendingQueue: PendingChatQueueState; isDark?: boolean }>();
const emit = defineEmits<{ (e: 'edit', entry: PendingTaskEntry): void; (e: 'restore', entry: PendingTaskEntry): void }>();
</script>

<template>
  <section
    v-if="pendingQueue.snapshot.value?.entries.length"
    class="w-full rounded-2xl border px-3.5 py-2.5 text-sm shadow-sm transition-all"
    :class="isDark
      ? 'border-amber-500/35 bg-stone-950/95 text-amber-50'
      : 'border-amber-300/90 bg-gradient-to-r from-amber-50/90 via-white to-orange-50/75 text-stone-900'"
    :aria-label="t('chat.pending.title')"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-lx-fs-sm font-semibold" :class="isDark ? 'text-amber-300' : 'text-amber-800'">QUEUE</span>
        <h3 class="text-xs font-semibold tracking-tight">{{ t('chat.pending.count', {count: pendingQueue.snapshot.value.entries.length}) }}</h3>
      </div>
      <button
        v-if="pendingQueue.snapshot.value.paused"
        type="button"
        class="shrink-0 rounded-xl px-3 py-1 text-xs font-semibold text-white transition cursor-pointer disabled:opacity-40 bg-gradient-to-r from-amber-500 to-orange-500 hover:brightness-105"
        :disabled="pendingQueue.changing.value"
        @click="pendingQueue.resume()"
      >{{ t('chat.pending.resume') }}</button>
    </div>

    <p v-if="pendingQueue.snapshot.value.failure || pendingQueue.error.value" class="mt-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500" role="alert">
      {{ pendingQueue.error.value || pendingQueue.snapshot.value.failure }}
    </p>

    <ol class="mt-2 max-h-32 space-y-1.5 overflow-y-auto pr-0.5 scrollbar-thin">
      <li
        v-for="(entry, index) in pendingQueue.snapshot.value.entries"
        :key="entry.id"
        class="flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-xs transition"
        :class="isDark ? 'border-amber-500/15 bg-white/[0.03]' : 'border-amber-200/70 bg-white'"
      >
        <span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-lx-fs-2xs font-bold" :class="isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-800'">
          {{ index + 1 }}
        </span>
        <span v-if="entry.attachments.length" class="flex shrink-0 items-center gap-1">
          <img
            v-for="attachment in entry.attachments.slice(0, 2)"
            :key="attachment.id"
            :src="pendingQueue.attachmentUrl(entry.id, attachment.id)"
            :alt="attachment.name"
            loading="lazy"
            decoding="async"
            data-testid="pending-attachment-thumb"
            class="h-6 w-6 shrink-0 rounded-md object-cover ring-1 ring-amber-400/40"
          />
          <span v-if="entry.attachments.length > 2" class="text-lx-fs-2xs font-semibold opacity-70">+{{ entry.attachments.length - 2 }}</span>
        </span>
        <span class="min-w-0 flex-1 truncate leading-5" :title="entry.input">{{ entry.input }}</span>
        <span v-if="entry.status === 'AWAITING_CONFIRM'" class="shrink-0 rounded-md px-2 py-0.5 text-lx-fs-sm bg-amber-500/15 text-amber-600 dark:text-amber-300">{{ t('chat.pending.awaitingConfirm') }}</span>
        <span v-if="entry.dispatching" class="shrink-0 rounded-md px-2 py-0.5 text-lx-fs-sm bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">{{ t('chat.pending.sending') }}</span>
        <div v-else class="flex shrink-0 items-center gap-1">
          <button v-if="entry.status !== 'PENDING'" type="button" data-testid="pending-confirm-btn" class="rounded-lg px-2 py-1 text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 cursor-pointer" :disabled="pendingQueue.changing.value" @click="pendingQueue.confirm(entry.id)">{{ t('chat.pending.confirm') }}</button>
          <button type="button" data-testid="pending-edit-btn" class="px-1.5 py-1 rounded-lg opacity-70 hover:opacity-100 cursor-pointer" :disabled="pendingQueue.changing.value" :title="t('chat.pending.edit')" @click="emit('edit', entry)">✎</button>
          <button type="button" data-testid="pending-cancel-btn" class="rounded-lg px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10 cursor-pointer" :disabled="pendingQueue.changing.value" @click="emit('restore', entry)">{{ t('chat.pending.cancel') }}</button>
        </div>
      </li>
    </ol>
  </section>
</template>
