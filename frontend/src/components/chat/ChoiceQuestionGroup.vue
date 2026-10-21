<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from 'vue';
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

function navigate(offset: number) {
  const next = props.entries[activeIndex.value + offset];
  if (next) activeId.value = next.card.toolCallId;
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
  <section :class="[CARD_SHELL_CLASS, 'w-full min-w-0 overflow-hidden', isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']" data-testid="choice-question-group">
    <header class="flex items-center justify-between gap-3 border-b px-4 py-3" :class="isDark ? 'border-white/10' : 'border-gray-100'">
      <span class="text-sm font-semibold">{{ t('chat.choice.groupTitle') }}</span>
      <span class="text-xs tabular-nums text-gray-500" role="status">{{ t('chat.choice.groupProgress', { answered, total }) }}</span>
    </header>
    <div class="flex flex-wrap gap-2 px-4 pt-3" role="tablist" :aria-label="t('chat.choice.groupTitle')">
      <button v-for="(entry, index) in entries" :key="entry.card.toolCallId" type="button" role="tab"
        :aria-selected="activeId === entry.card.toolCallId" :aria-controls="`question-${entry.card.toolCallId}`"
        class="rounded-lg border px-3 py-1.5 text-xs tabular-nums transition cursor-pointer"
        :class="activeId === entry.card.toolCallId ? 'border-blue-500 bg-blue-500/10 text-blue-500' : (isDark ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-600')"
        :data-choice-tab="index" @click="activeId = entry.card.toolCallId">
        {{ index + 1 }}<span v-if="entry.card.status === 'completed' || answer(entry).trim()" class="ml-1" :aria-label="t('chat.choice.draftAnswered')">✓</span>
      </button>
    </div>
    <div v-if="active && draft" :id="`question-${active.toolCallId}`" role="tabpanel" class="space-y-3 px-4 py-4">
      <p class="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed" data-testid="choice-question">{{ active.content || active.title }}</p>
      <div v-if="active.status === 'completed'" class="whitespace-pre-wrap break-words text-sm text-gray-500" data-testid="choice-confirmed-answer">
        <template v-if="active.outcome === 'ANSWERED'">{{ t('chat.choice.confirmedDecision') }}{{ active.answer }}</template>
        <template v-else>{{ resolveCardStatusLabel(active) }}</template>
      </div>
      <template v-else>
        <div class="space-y-2" role="radiogroup" :aria-label="active.title">
          <button v-for="(option, index) in active.options || []" :key="index" type="button" role="radio"
            :aria-checked="!draft.useCustom && draft.selected === index" :disabled="!editable"
            class="flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-60 cursor-pointer disabled:cursor-default"
            :class="!draft.useCustom && draft.selected === index ? 'border-blue-500 bg-blue-500/10' : (isDark ? 'border-gray-700 hover:bg-white/5' : 'border-gray-200 hover:bg-gray-50')"
            :data-choice-option="index" @click="draft.selected = index; draft.useCustom = false">
            <span class="shrink-0 text-xs text-gray-500">{{ index + 1 }}</span><span class="whitespace-pre-wrap break-words">{{ option }}</span>
          </button>
          <label class="flex items-center gap-2 text-xs text-gray-500">
            <input v-model="draft.useCustom" type="checkbox" :disabled="!editable" data-testid="choice-custom-toggle" />{{ t('chat.choice.customAnswerPlaceholder') }}
          </label>
          <textarea v-if="draft.useCustom" v-model="draft.custom" :disabled="!editable" rows="3"
            :aria-label="t('chat.choice.customAnswerPlaceholder')" :placeholder="t('chat.choice.customAnswerPlaceholder')"
            class="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
            :class="isDark ? 'border-gray-700' : 'border-gray-200'" data-testid="choice-custom-input" />
        </div>
      </template>
      <div class="flex items-center justify-between gap-3 text-xs">
        <button type="button" :disabled="activeIndex <= 0" class="rounded px-2 py-1 text-gray-500 disabled:opacity-30 cursor-pointer disabled:cursor-default" data-testid="choice-previous" @click="navigate(-1)">{{ t('chat.choice.previous') }}</button>
        <span class="tabular-nums text-gray-400">{{ activeIndex + 1 }} / {{ total }}</span>
        <button type="button" :disabled="activeIndex >= entries.length - 1" class="rounded px-2 py-1 text-gray-500 disabled:opacity-30 cursor-pointer disabled:cursor-default" data-testid="choice-next" @click="navigate(1)">{{ t('chat.choice.next') }}</button>
      </div>
    </div>
    <footer v-if="pending.length || error" class="space-y-2 border-t px-4 py-3" :class="isDark ? 'border-white/10' : 'border-gray-100'">
      <p v-if="error" :class="['text-xs', CARD_ERROR_TEXT_CLASS]" role="alert">{{ error }}</p>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs text-gray-500">{{ !ready ? t('chat.choice.groupPreparing') : t('chat.choice.groupHint') }}</span>
        <CardActionButton tone="blue" :loading="submitting" :disabled="!canSubmit" :is-dark="isDark" data-testid="choice-submit-all" @click="submit">{{ t('chat.choice.submitAll') }}</CardActionButton>
      </div>
    </footer>
  </section>
</template>
