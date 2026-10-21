<script setup lang="ts">
import { computed, inject, nextTick, reactive, ref, watch } from 'vue';
import type { PromptCardEntry } from '../../utils/promptCardGroups';
import { ANSWER_CHOICES_KEY, type ChoiceAnswersPayload } from '../../types/toolDecision';
import { canDecideCard, resolveCardStatusLabel } from '../../utils/toolCallCard';
import { createLocalId } from '../../utils/ids';
import { CARD_SHELL_CLASS, CARD_ERROR_TEXT_CLASS } from '../../utils/cardUi';
import { useI18n } from '../../i18n';
import CardActionButton from './CardActionButton.vue';

const props = defineProps<{ entries: PromptCardEntry[]; responseId: string; expectedCount: number; isDark?: boolean }>();
const { t } = useI18n();
const answerChoices = inject(ANSWER_CHOICES_KEY, null);
interface Draft { version?: string; selected: number | null; custom: string; useCustom: boolean }
const drafts = reactive<Record<string, Draft>>({});
const activeId = ref('');
const submitting = ref(false);
const error = ref('');
const retry = ref<{ signature: string; payload: ChoiceAnswersPayload } | null>(null);
const dismissed = ref(false);
const customInput = ref<HTMLTextAreaElement | null>(null);

watch(() => props.entries, entries => {
  for (const { card } of entries) {
    if (!drafts[card.toolCallId] || drafts[card.toolCallId]!.version !== card.version) {
      drafts[card.toolCallId] = { version: card.version, selected: null, custom: '', useCustom: false };
    }
  }
  if (!entries.some(entry => entry.card.toolCallId === activeId.value)) activeId.value = entries[0]?.card.toolCallId ?? '';
}, { immediate: true, deep: true });

const active = computed(() => props.entries.find(entry => entry.card.toolCallId === activeId.value)?.card);
const draft = computed(() => drafts[activeId.value]);
const activeIndex = computed(() => props.entries.findIndex(entry => entry.card.toolCallId === activeId.value));
const pending = computed(() => props.entries.filter(entry => entry.card.status !== 'completed'));
const total = computed(() => Math.max(props.expectedCount, props.entries.length));
const ready = computed(() => props.entries.length === total.value && pending.value.every(entry =>
  canDecideCard(entry.card, 'ANSWER') && !!entry.card.version));
const answer = (entry: PromptCardEntry): string => {
  const value = drafts[entry.card.toolCallId];
  if (!value) return '';
  return value.useCustom ? value.custom : value.selected === null ? '' : entry.card.options?.[value.selected] ?? '';
};
const answered = computed(() => props.entries.filter(entry => entry.card.status === 'completed' || answer(entry).trim()).length);
const canSubmit = computed(() => ready.value && pending.value.length > 0 && answered.value === total.value && !submitting.value);
const editable = computed(() => !!active.value && canDecideCard(active.value, 'ANSWER') && !submitting.value);
/** 题干占用标题位：优先正文，其次标题，全缺时回落分组名。 */
const questionText = computed(() => active.value?.content || active.value?.title || t('chat.choice.groupTitle'));
/** 组内还有待答题时不允许关掉这张卡——关掉等于把唯一的作答入口藏起来。 */
const closable = computed(() => pending.value.length === 0);

function navigate(offset: number) {
  const next = props.entries[activeIndex.value + offset];
  if (next) activeId.value = next.card.toolCallId;
}

function selectOption(index: number) {
  if (!draft.value || !editable.value) return;
  draft.value.selected = index;
  draft.value.useCustom = false;
}

function activateCustom() {
  if (!draft.value || !editable.value) return;
  draft.value.useCustom = true;
  draft.value.selected = null;
  void nextTick(() => customInput.value?.focus());
}

async function submit() {
  if (!canSubmit.value) return;
  if (!answerChoices) { error.value = t('chat.choice.noDecisionChannel'); return; }
  const conversationId = props.entries[0]?.card.conversationId;
  if (!conversationId) { error.value = t('chat.choice.missingConversation'); return; }
  const content = {
    conversationId, responseId: props.responseId,
    answers: pending.value.map(entry => ({ toolCallId: entry.card.toolCallId,
      expectedVersion: entry.card.version!, text: answer(entry) }))
  };
  const signature = JSON.stringify(content);
  if (retry.value?.signature !== signature) {
    retry.value = { signature, payload: { ...content, commandId: createLocalId('choice') } };
  }
  submitting.value = true;
  error.value = '';
  try { await answerChoices(retry.value!.payload); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : t('chat.choice.submitFailed'); }
  finally { submitting.value = false; }
}
</script>

<template>
  <section v-if="!dismissed" :class="[CARD_SHELL_CLASS, 'w-full min-w-0 overflow-hidden', isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']" data-testid="choice-question-group">
    <header class="flex items-start justify-between gap-3 px-4 py-3">
      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-semibold leading-relaxed" data-testid="choice-question">{{ questionText }}</p>
      <div class="flex shrink-0 items-center gap-0.5">
        <template v-if="entries.length > 1">
          <button type="button" :disabled="activeIndex <= 0" :aria-label="t('chat.choice.previous')"
            class="rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            :class="isDark ? 'hover:bg-white/10 hover:text-gray-200' : ''" data-testid="choice-previous" @click="navigate(-1)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 5-7 7 7 7" /></svg>
          </button>
          <span class="min-w-8 text-center text-xs tabular-nums text-gray-500" role="status">{{ activeIndex + 1 }} / {{ total }}</span>
          <button type="button" :disabled="activeIndex >= entries.length - 1" :aria-label="t('chat.choice.next')"
            class="rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            :class="isDark ? 'hover:bg-white/10 hover:text-gray-200' : ''" data-testid="choice-next" @click="navigate(1)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
          </button>
        </template>
        <button v-if="closable" type="button" :title="t('common.close')" :aria-label="t('common.close')"
          class="ml-1 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 cursor-pointer"
          :class="isDark ? 'hover:bg-white/10 hover:text-gray-200' : ''" data-testid="choice-dismiss" @click="dismissed = true">
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </header>
    <div v-if="active && draft" :id="`question-${active.toolCallId}`" class="px-4 pb-4">
      <div v-if="active.status === 'completed'" class="whitespace-pre-wrap break-words text-sm text-gray-500" data-testid="choice-confirmed-answer">
        <template v-if="active.outcome === 'ANSWERED'">{{ t('chat.choice.confirmedDecision') }}{{ active.answer }}</template>
        <template v-else>{{ resolveCardStatusLabel(active) }}</template>
      </div>
      <template v-else>
        <div class="space-y-1.5" role="radiogroup" :aria-label="active.title">
          <button v-for="(option, index) in active.options || []" :key="index" type="button" role="radio"
            :aria-checked="!draft.useCustom && draft.selected === index" :disabled="!editable"
            class="group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-60 cursor-pointer disabled:cursor-default"
            :class="!draft.useCustom && draft.selected === index
              ? (isDark ? 'border-blue-500/60 bg-blue-500/15 text-gray-100' : 'border-blue-200 bg-blue-50 text-blue-900')
              : (isDark ? 'border-white/10 hover:border-blue-500/30 hover:bg-white/5' : 'border-gray-100 hover:border-blue-200 hover:bg-blue-50/50')"
            :data-choice-option="index" @click="selectOption(index)">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-colors"
              :class="!draft.useCustom && draft.selected === index
                ? 'bg-blue-500 text-white'
                : (isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-100 text-gray-500')">{{ index + 1 }}</span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ option }}</span>
            <svg class="h-3.5 w-3.5 shrink-0 transition-colors" :class="!draft.useCustom && draft.selected === index ? 'text-blue-500' : (isDark ? 'text-gray-600' : 'text-gray-300')"
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
          </button>
          <div class="border-t pt-1.5" :class="isDark ? 'border-white/10' : 'border-gray-100'">
            <button type="button" role="radio" :aria-checked="draft.useCustom" :disabled="!editable"
              class="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-60 cursor-pointer disabled:cursor-default"
              :class="draft.useCustom
                ? (isDark ? 'border-blue-500/60 bg-blue-500/15' : 'border-blue-200 bg-blue-50')
                : (isDark ? 'border-transparent hover:bg-white/5' : 'border-transparent hover:bg-gray-50')"
              data-testid="choice-custom-toggle" @click="activateCustom">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors"
                :class="draft.useCustom ? 'bg-blue-500 text-white' : (isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-100 text-gray-400')">
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
              </span>
              <span class="min-w-0 flex-1 text-xs" :class="isDark ? 'text-gray-400' : 'text-gray-500'">{{ t('chat.choice.customRowLabel') }}</span>
            </button>
            <textarea v-if="draft.useCustom" ref="customInput" v-model="draft.custom" :disabled="!editable" rows="2"
              :aria-label="t('chat.choice.customAnswerPlaceholder')" :placeholder="t('chat.choice.customAnswerPlaceholder')"
              class="mt-1.5 w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-400"
              :class="isDark ? 'border-white/10 focus:border-blue-500/60' : 'border-gray-200' " data-testid="choice-custom-input" />
          </div>
        </div>
      </template>
    </div>
    <footer v-if="pending.length || error" class="space-y-2 border-t px-4 py-3" :class="isDark ? 'border-white/10' : 'border-gray-100'">
      <p v-if="error" :class="['text-xs', CARD_ERROR_TEXT_CLASS]" role="alert">{{ error }}</p>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs text-gray-500">{{ !ready ? t('chat.choice.groupPreparing') : (canSubmit ? t('chat.choice.groupProgress', { answered, total }) : t('chat.choice.groupHint')) }}</span>
        <CardActionButton tone="blue" :loading="submitting" :disabled="!canSubmit" :is-dark="isDark" data-testid="choice-submit-all" @click="submit">{{ t('chat.choice.submitAll') }}</CardActionButton>
      </div>
    </footer>
  </section>
</template>
