<script setup lang="ts">
import {computed, ref} from 'vue';
import type {PendingTaskEntry} from '../../types/chat';
import type {PendingChatQueueState} from '../../types/taskProgressSlots';
import {t} from '../../i18n';

const props = defineProps<{ pendingQueue: PendingChatQueueState; isDark?: boolean }>();
const emit = defineEmits<{ (e: 'edit', entry: PendingTaskEntry): void; (e: 'restore', entry: PendingTaskEntry): void }>();

const expandedEntryIds = ref<Set<string>>(new Set());

const totalAttachments = computed(() =>
  (props.pendingQueue.snapshot.value?.entries ?? []).reduce((sum, entry) => sum + entry.attachments.length, 0),
);

function toggleExpandInput(entryId: string) {
  const next = new Set(expandedEntryIds.value);
  if (next.has(entryId)) next.delete(entryId);
  else next.add(entryId);
  expandedEntryIds.value = next;
}
</script>

<template>
  <section
    v-if="pendingQueue.snapshot.value?.entries.length"
    class="w-full rounded-2xl border px-3.5 py-2.5 text-sm backdrop-blur-xl transition-all"
    :class="isDark
      ? 'border-cyan-400/35 bg-slate-950/92 text-slate-100 shadow-[0_14px_36px_-10px_rgba(34,211,238,0.28)]'
      : 'border-indigo-200 bg-gradient-to-r from-sky-50/90 via-white/95 to-indigo-50/85 text-slate-800 shadow-[0_10px_28px_-8px_rgba(79,70,229,0.18)]'"
    :aria-label="t('chat.pending.title')"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-lx-fs-2xs font-bold uppercase tracking-wider"
          :class="pendingQueue.snapshot.value.paused
            ? (isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-800')
            : (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-indigo-100 text-indigo-700')"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-current lx-live-dot" aria-hidden="true" />
          {{ pendingQueue.snapshot.value.paused ? 'PAUSED' : 'READY' }}
        </span>
        <h3 class="text-xs font-semibold tracking-tight">{{ t('chat.pending.count', {count: pendingQueue.snapshot.value.entries.length}) }}</h3>
        <span
          v-if="totalAttachments > 0"
          class="rounded-md px-1.5 py-0.5 font-mono text-lx-fs-2xs"
          :class="isDark ? 'bg-white/10 text-slate-300' : 'bg-indigo-100/70 text-indigo-700'"
        >📎 {{ totalAttachments }}</span>
      </div>

      <button
        v-if="pendingQueue.snapshot.value.paused"
        type="button"
        class="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-white transition cursor-pointer disabled:opacity-40 bg-gradient-to-r from-cyan-500 to-indigo-500 hover:brightness-110"
        :disabled="pendingQueue.changing.value"
        @click="pendingQueue.resume()"
      >{{ t('chat.pending.resume') }}</button>
    </div>

    <p v-if="pendingQueue.snapshot.value.failure || pendingQueue.error.value" class="mt-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-500" role="alert">
      {{ pendingQueue.error.value || pendingQueue.snapshot.value.failure }}
    </p>

    <ol class="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-0.5 scrollbar-thin">
      <li
        v-for="(entry, index) in pendingQueue.snapshot.value.entries"
        :key="entry.id"
        class="rounded-xl border px-2.5 py-2 text-xs transition"
        :class="index === 0
          ? (isDark ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-indigo-300 bg-indigo-50/75')
          : (isDark ? 'border-white/10 bg-white/[0.03] hover:border-cyan-400/35' : 'border-indigo-100 bg-white/85 hover:border-indigo-200')"
      >
        <div class="flex items-start gap-2.5">
          <div class="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
            <span
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 font-mono text-lx-fs-2xs font-bold text-white"
              :class="index === 0 ? 'bg-gradient-to-br from-cyan-400 to-indigo-500' : (isDark ? 'bg-white/15' : 'bg-slate-400')"
            >{{ index + 1 }}</span>
            <span v-if="index === 0" class="font-mono text-[9px] font-bold tracking-wider text-cyan-500">NEXT</span>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-2">
              <span
                class="min-w-0 flex-1 leading-5"
                :class="expandedEntryIds.has(entry.id) ? 'whitespace-pre-wrap break-words' : 'truncate'"
                :title="entry.input"
              >{{ entry.input }}</span>
              <button
                v-if="entry.input.length > 48"
                type="button"
                class="shrink-0 rounded px-1 py-0.5 text-lx-fs-2xs opacity-65 hover:opacity-100 cursor-pointer"
                @click="toggleExpandInput(entry.id)"
              >{{ expandedEntryIds.has(entry.id) ? '收起' : '展开' }}</button>
            </div>

            <div v-if="entry.attachments.length" class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <img
                v-for="attachment in entry.attachments.slice(0, 3)"
                :key="attachment.id"
                :src="pendingQueue.attachmentUrl(entry.id, attachment.id)"
                :alt="attachment.name"
                :title="attachment.name"
                loading="lazy"
                decoding="async"
                data-testid="pending-attachment-thumb"
                class="h-7 w-7 shrink-0 rounded-md object-cover ring-1 ring-cyan-400/30"
              />
              <span v-if="entry.attachments.length > 3" class="text-lx-fs-2xs font-semibold opacity-70">+{{ entry.attachments.length - 3 }}</span>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1 pt-0.5">
            <span v-if="entry.status === 'AWAITING_CONFIRM'" class="rounded-md px-2 py-0.5 text-lx-fs-sm bg-amber-500/15 text-amber-500">{{ t('chat.pending.awaitingConfirm') }}</span>
            <span v-if="entry.dispatching" class="rounded-md px-2 py-0.5 text-lx-fs-sm bg-cyan-500/15 text-cyan-500">{{ t('chat.pending.sending') }}</span>
            <template v-else>
              <button v-if="entry.status !== 'PENDING'" type="button" data-testid="pending-confirm-btn" class="rounded-lg px-2 py-1 text-xs font-medium bg-cyan-500/15 text-cyan-500 hover:bg-cyan-500/25 cursor-pointer" :disabled="pendingQueue.changing.value" @click="pendingQueue.confirm(entry.id)">{{ t('chat.pending.confirm') }}</button>
              <button type="button" data-testid="pending-edit-btn" class="px-1.5 py-1 rounded-lg opacity-70 hover:opacity-100 cursor-pointer" :disabled="pendingQueue.changing.value" :title="t('chat.pending.edit')" @click="emit('edit', entry)">✎</button>
              <button type="button" data-testid="pending-cancel-btn" class="rounded-lg px-2 py-1 text-xs text-rose-500 hover:bg-rose-500/10 cursor-pointer" :disabled="pendingQueue.changing.value" @click="emit('restore', entry)">{{ t('chat.pending.cancel') }}</button>
            </template>
          </div>
        </div>
      </li>
    </ol>
  </section>
</template>
