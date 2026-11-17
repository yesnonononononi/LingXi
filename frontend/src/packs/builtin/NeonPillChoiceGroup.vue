<script setup lang="ts">
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
  answeredStates,
  canSubmit,
  editable,
  normalizedQuestionText,
  closable,
  summary,
  expanded,
  submitting,
  error,
  customInput,
  selectQuestion,
  selectOption,
  activateCustom,
  submit,
} = useChoiceGroupModel(props);
</script>

<template>
  <div class="w-full min-w-0">
    <button
      v-if="closable"
      type="button"
      :aria-expanded="expanded"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs transition cursor-pointer"
      :class="isDark ? 'text-cyan-300 hover:text-cyan-200' : 'text-indigo-700 hover:text-indigo-900'"
      data-testid="choice-summary-toggle"
      @click="expanded = !expanded"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass('approved')" />
      <span class="truncate">{{ summary }}</span>
    </button>

    <section
      v-if="!closable || expanded"
      class="relative w-full min-w-0 overflow-hidden rounded-2xl border backdrop-blur-md transition-all"
      :class="[
        docked ? 'my-0.5' : 'my-2.5',
        isDark
          ? 'border-cyan-400/35 bg-gradient-to-br from-slate-950 via-indigo-950/75 to-fuchsia-950/50 text-slate-100 shadow-[0_0_28px_-6px_rgba(34,211,238,0.26)]'
          : 'border-indigo-200 bg-gradient-to-br from-cyan-50/90 via-white to-fuchsia-50/80 text-slate-900 shadow-[0_10px_28px_-8px_rgba(99,102,241,0.18)]'
      ]"
      data-testid="choice-question-group"
    >
      <!-- 顶部可视化点阵步骤条 -->
      <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
        <div class="flex items-center gap-1.5">
          <button
            v-for="(entry, idx) in entries"
            :key="entry.card.toolCallId"
            type="button"
            class="h-2 rounded-full transition-all cursor-pointer"
            :class="idx === activeIndex
              ? 'w-6 bg-gradient-to-r from-cyan-400 to-fuchsia-500'
              : answeredStates[idx]
                ? 'w-2 bg-cyan-500'
                : (isDark ? 'w-2 bg-white/20 hover:bg-white/40' : 'w-2 bg-slate-300 hover:bg-slate-400')"
            :aria-label="`${idx + 1} / ${total}`"
            @click="selectQuestion(idx)"
          />
        </div>
        <div class="flex items-center gap-2">
          <span v-if="entries.length > 1" class="text-xs font-medium tabular-nums opacity-75" role="status">
            {{ activeIndex + 1 }} / {{ total }}
          </span>
          <button
            v-if="closable"
            type="button"
            :title="t('common.close')"
            class="rounded-md px-1.5 py-0.5 text-xs cursor-pointer opacity-70 hover:opacity-100"
            @click="expanded = false"
          >✕</button>
        </div>
      </div>

      <div
        class="scrollbar-thin max-h-[160px] overflow-y-auto px-4 pb-3 text-sm leading-relaxed [&_.markdown-body>*:first-child]:mt-0 [&_.markdown-body>*:last-child]:mb-0"
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
          <!-- 双列霓虹胶囊矩阵 -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" :aria-label="active.title">
            <button
              v-for="(option, index) in active.options || []"
              :key="index"
              type="button"
              role="radio"
              :aria-checked="!draft.useCustom && draft.selected === index"
              :disabled="!editable"
              class="group flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 text-left text-sm transition-all cursor-pointer disabled:opacity-60"
              :class="!draft.useCustom && draft.selected === index
                ? (isDark
                  ? 'border-cyan-400 bg-gradient-to-r from-cyan-500/20 to-fuchsia-500/20 shadow-[0_0_18px_rgba(34,211,238,0.28)]'
                  : 'border-indigo-500 bg-gradient-to-r from-cyan-50 to-indigo-50 shadow-sm ring-1 ring-indigo-500/20')
                : (isDark
                  ? 'border-white/10 bg-white/[0.03] hover:border-cyan-400/50 hover:bg-white/[0.06]'
                  : 'border-slate-200/80 bg-white/85 hover:border-indigo-300 hover:bg-white')"
              :data-choice-option="index"
              @click="selectOption(index)"
            >
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors"
                :class="!draft.useCustom && draft.selected === index
                  ? 'bg-gradient-to-r from-cyan-400 to-fuchsia-500 text-white'
                  : (isDark ? 'bg-white/10 text-slate-300' : 'bg-slate-100 text-slate-600')"
              >{{ index + 1 }}</span>
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ option }}</span>
            </button>
          </div>

          <div
            class="mt-2 flex items-center gap-2.5 rounded-2xl border px-3.5 py-2 transition-all"
            :class="draft.useCustom
              ? (isDark ? 'border-cyan-400 bg-cyan-500/15' : 'border-indigo-500 bg-indigo-50/70')
              : (isDark ? 'border-white/10 bg-white/[0.03] hover:border-cyan-400/50' : 'border-slate-200/80 bg-white/85 hover:border-indigo-300')"
            role="presentation"
            data-testid="choice-custom-toggle"
            @click="activateCustom"
          >
            <span
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs"
              :class="draft.useCustom ? 'bg-gradient-to-r from-cyan-400 to-fuchsia-500 text-white' : (isDark ? 'bg-white/10 text-slate-300' : 'bg-slate-100 text-slate-500')"
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

      <footer v-if="pending.length || error" class="border-t px-4 py-2.5 space-y-2" :class="isDark ? 'border-white/10 bg-black/25' : 'border-indigo-100 bg-white/70'">
        <p v-if="error" :class="['text-xs', CARD_ERROR_TEXT_CLASS]" role="alert">{{ error }}</p>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-xs opacity-70">
            {{ !ready ? t('chat.choice.groupPreparing') : (canSubmit ? t('chat.choice.groupProgress', { answered, total }) : t('chat.choice.groupHint')) }}
          </span>
          <button
            type="button"
            :disabled="!canSubmit"
            class="rounded-full px-5 py-1.5 text-xs font-semibold text-white shadow-sm transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-500 via-indigo-500 to-fuchsia-500 hover:brightness-110"
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
