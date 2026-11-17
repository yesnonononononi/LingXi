<script setup lang="ts">
import {onMounted, onScopeDispose} from 'vue';
import type {PromptCardEntry} from '../../utils/promptCardGroups';
import {resolveCardStatusLabel} from '../../utils/toolCallCard';
import {CARD_ERROR_TEXT_CLASS, cardDotClass} from '../../utils/cardUi';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.vue';
import {useChoiceGroupModel} from './useInteractionCardActions';

const props = defineProps<{
  entries: PromptCardEntry[];
  responseId: string;
  expectedCount: number;
  isDark?: boolean;
  docked?: boolean;
}>();

const {
  t,
  active,
  draft,
  activeIndex,
  pending,
  total,
  ready,
  answered,
  canSubmit,
  editable,
  normalizedQuestionText,
  closable,
  summary,
  expanded,
  submitting,
  error,
  customInput,
  navigate,
  selectOption,
  activateCustom,
  submit,
} = useChoiceGroupModel(props);

const badgeLetter = (idx: number) => idx < 26 ? String.fromCharCode(65 + idx) : String(idx + 1);

function onKeydown(event: KeyboardEvent) {
  if (closable.value && !expanded.value) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    if (canSubmit.value) {
      event.preventDefault();
      void submit();
    }
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navigate(-1);
    return;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigate(1);
    return;
  }
  if (!editable.value || !active.value?.options?.length) return;
  const optionCount = active.value.options.length;
  if (/^[1-9]$/.test(event.key)) {
    const idx = Number(event.key) - 1;
    if (idx < optionCount) {
      event.preventDefault();
      selectOption(idx);
    }
    return;
  }
  if (/^[a-zA-Z]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const idx = event.key.toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < optionCount) {
      event.preventDefault();
      selectOption(idx);
    }
  }
}

onMounted(() => { window.addEventListener('keydown', onKeydown); });
onScopeDispose(() => { window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div class="w-full min-w-0">
    <button
      v-if="closable"
      type="button"
      :aria-expanded="expanded"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs transition cursor-pointer"
      :class="isDark ? 'text-amber-300 hover:text-amber-200' : 'text-amber-800 hover:text-amber-950'"
      data-testid="choice-summary-toggle"
      @click="expanded = !expanded"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass('approved')" />
      <span class="truncate">{{ summary }}</span>
    </button>

    <section
      v-if="!closable || expanded"
      class="relative w-full min-w-0 overflow-hidden rounded-2xl border-2 transition-all"
      :class="[
        docked ? 'my-0.5' : 'my-2.5',
        isDark
          ? 'border-amber-500/45 bg-gradient-to-b from-stone-950 via-zinc-950 to-amber-950/35 text-amber-50 shadow-[0_12px_32px_-8px_rgba(245,158,11,0.22)]'
          : 'border-amber-400/75 bg-gradient-to-b from-amber-50/90 via-orange-50/40 to-white text-stone-900 shadow-[0_10px_28px_-8px_rgba(180,83,9,0.16)]'
      ]"
      data-testid="choice-question-group"
    >
      <!-- 顶部星辉金装饰线 -->
      <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5" :class="isDark ? 'border-amber-500/25 bg-amber-500/10' : 'border-amber-300/60 bg-amber-100/55'">
        <div class="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase" :class="isDark ? 'text-amber-300' : 'text-amber-900'">
          <span class="inline-block h-2 w-2 rotate-45 bg-amber-500" aria-hidden="true" />
          <span>QUEST DECISION</span>
        </div>
        <div class="flex items-center gap-1">
          <template v-if="entries.length > 1">
            <button
              type="button"
              :disabled="activeIndex <= 0"
              :aria-label="t('chat.choice.previous')"
              class="rounded-md px-1.5 py-0.5 text-xs transition cursor-pointer disabled:opacity-30 disabled:cursor-default"
              :class="isDark ? 'text-amber-200 hover:bg-amber-500/20' : 'text-amber-800 hover:bg-amber-200/60'"
              data-testid="choice-previous"
              @click="navigate(-1)"
            >‹</button>
            <span class="min-w-8 text-center text-xs font-semibold tabular-nums" :class="isDark ? 'text-amber-200' : 'text-amber-900'" role="status">
              {{ activeIndex + 1 }} / {{ total }}
            </span>
            <button
              type="button"
              :disabled="activeIndex >= entries.length - 1"
              :aria-label="t('chat.choice.next')"
              class="rounded-md px-1.5 py-0.5 text-xs transition cursor-pointer disabled:opacity-30 disabled:cursor-default"
              :class="isDark ? 'text-amber-200 hover:bg-amber-500/20' : 'text-amber-800 hover:bg-amber-200/60'"
              data-testid="choice-next"
              @click="navigate(1)"
            >›</button>
          </template>
          <button
            v-if="closable"
            type="button"
            :title="t('common.close')"
            class="ml-1 rounded-md px-1.5 py-0.5 text-xs cursor-pointer"
            @click="expanded = false"
          >✕</button>
        </div>
      </div>

      <div
        class="scrollbar-thin max-h-[160px] overflow-y-auto px-4 pt-3 pb-2 text-sm leading-relaxed [&_.markdown-body>*:first-child]:mt-0 [&_.markdown-body>*:last-child]:mb-0"
        data-testid="choice-question"
      >
        <MarkdownRenderer :content="normalizedQuestionText" :is-dark="isDark" :streaming="false" />
      </div>

      <div v-if="active && draft" class="px-4 pb-3">
        <div v-if="active.status === 'completed'" class="text-sm opacity-75" data-testid="choice-confirmed-answer">
          <template v-if="active.outcome === 'ANSWERED'">{{ t('chat.choice.confirmedDecision') }}{{ active.answer }}</template>
          <template v-else>{{ resolveCardStatusLabel(active) }}</template>
        </div>
        <template v-else>
          <div class="space-y-1.5" role="radiogroup" :aria-label="active.title">
            <button
              v-for="(option, index) in active.options || []"
              :key="index"
              type="button"
              role="radio"
              :aria-checked="!draft.useCustom && draft.selected === index"
              :disabled="!editable"
              class="group flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition cursor-pointer disabled:opacity-60"
              :class="!draft.useCustom && draft.selected === index
                ? (isDark ? 'border-amber-400 bg-amber-500/15 shadow-[0_0_16px_rgba(245,158,11,0.22)]' : 'border-amber-500 bg-amber-100/80 shadow-xs')
                : (isDark ? 'border-amber-500/20 bg-white/[0.02] hover:border-amber-400/50 hover:bg-amber-500/5' : 'border-amber-200/80 bg-white/80 hover:border-amber-400 hover:bg-amber-50/70')"
              :data-choice-option="index"
              @click="selectOption(index)"
            >
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold transition-colors"
                :class="!draft.useCustom && draft.selected === index
                  ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-stone-950'
                  : (isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-800')"
              >{{ badgeLetter(index) }}</span>
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium">{{ option }}</span>
              <span
                class="shrink-0 text-xs transition-transform"
                :class="!draft.useCustom && draft.selected === index ? 'text-amber-500 translate-x-0' : 'opacity-0 -translate-x-1 group-hover:opacity-50'"
              >▶</span>
            </button>
          </div>

          <div
            class="mt-1.5 flex items-center gap-3 rounded-xl border px-3 py-2 transition"
            :class="draft.useCustom
              ? (isDark ? 'border-amber-400 bg-amber-500/15' : 'border-amber-500 bg-amber-100/80')
              : (isDark ? 'border-amber-500/20 bg-white/[0.02] hover:border-amber-400/50' : 'border-amber-200/80 bg-white/80 hover:border-amber-400')"
            role="presentation"
            data-testid="choice-custom-toggle"
            @click="activateCustom"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold"
              :class="draft.useCustom ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-stone-950' : (isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-800')"
            >✎</span>
            <textarea
              ref="customInput"
              v-model="draft.custom"
              :disabled="!editable"
              rows="1"
              :aria-label="t('chat.choice.customAnswerPlaceholder')"
              :placeholder="t('chat.choice.customRowLabel')"
              class="h-5 min-w-0 flex-1 resize-none bg-transparent text-sm leading-5 outline-none placeholder:opacity-55"
              data-testid="choice-custom-input"
            />
          </div>
        </template>
      </div>

      <footer v-if="pending.length || error" class="border-t px-4 py-2.5 space-y-2" :class="isDark ? 'border-amber-500/20 bg-black/25' : 'border-amber-200/70 bg-amber-50/60'">
        <p v-if="error" :class="['text-xs', CARD_ERROR_TEXT_CLASS]" role="alert">{{ error }}</p>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-xs opacity-75">
            <span>{{ !ready ? t('chat.choice.groupPreparing') : (canSubmit ? t('chat.choice.groupProgress', { answered, total }) : t('chat.choice.groupHint')) }}</span>
            <span class="hidden sm:inline-block rounded px-1.5 py-0.5 font-mono text-lx-fs-sm opacity-80" :class="isDark ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-200/60 text-amber-900'">
              A–Z / 1–9 · Ctrl+Enter
            </span>
          </div>
          <button
            type="button"
            :disabled="!canSubmit"
            class="rounded-xl px-4 py-1.5 text-xs font-semibold text-stone-950 shadow-sm transition active:scale-[0.97] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 hover:brightness-105"
            data-testid="choice-submit-all"
            @click="submit"
          >
            {{ submitting ? '...' : t('chat.choice.submitAll') }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
