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
/** 无选项时（纯自由回答）不留固定滚动区，否则是一整块空白。 */
const scrollable = computed(() => (active.value?.options?.length ?? 0) > 0);
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

/** 点「其他补充」整行即可输入：不弹第二块输入框，光标直接落到行内。 */
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
  <section v-if="!dismissed" :class="[CARD_SHELL_CLASS, 'w-full min-w-0 overflow-hidden', isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200/90']" data-testid="choice-question-group">
    <header class="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
      <!-- 题干固定两行高、可内部滚动：四道题来回切换时卡片不能跳高度 -->
      <p class="scrollbar-thin h-[46px] min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-sm font-semibold leading-relaxed"
        :class="isDark ? 'text-white text-glow-white' : ''" data-testid="choice-question">{{ questionText }}</p>
      <div class="flex shrink-0 items-center gap-0.5">
        <template v-if="entries.length > 1">
          <button type="button" :disabled="activeIndex <= 0" :aria-label="t('chat.choice.previous')"
            class="rounded-md p-1 transition disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            :class="isDark ? 'text-gray-400 hover:bg-white/10 hover:text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'"
            data-testid="choice-previous" @click="navigate(-1)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 5-7 7 7 7" /></svg>
          </button>
          <span class="min-w-8 text-center text-xs tabular-nums" :class="isDark ? 'text-gray-300 text-glow-subtle' : 'text-gray-500'" role="status">{{ activeIndex + 1 }} / {{ total }}</span>
          <button type="button" :disabled="activeIndex >= entries.length - 1" :aria-label="t('chat.choice.next')"
            class="rounded-md p-1 transition disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            :class="isDark ? 'text-gray-400 hover:bg-white/10 hover:text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'"
            data-testid="choice-next" @click="navigate(1)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
          </button>
        </template>
        <button v-if="closable" type="button" :title="t('common.close')" :aria-label="t('common.close')"
          class="ml-1 rounded-md p-1 transition cursor-pointer"
          :class="isDark ? 'text-gray-400 hover:bg-white/10 hover:text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'"
          data-testid="choice-dismiss" @click="dismissed = true">
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </header>
    <div v-if="active && draft" :id="`question-${active.toolCallId}`" class="px-4 pb-3">
      <div v-if="active.status === 'completed'" class="whitespace-pre-wrap break-words text-sm" :class="isDark ? 'text-gray-400 text-glow-subtle' : 'text-gray-500'" data-testid="choice-confirmed-answer">
        <template v-if="active.outcome === 'ANSWERED'">{{ t('chat.choice.confirmedDecision') }}{{ active.answer }}</template>
        <template v-else>{{ resolveCardStatusLabel(active) }}</template>
      </div>
      <template v-else>
        <!-- 选项框固定高度：选项再多也只滚动，不撑爆卡片 -->
        <div class="scrollbar-thin -mr-1 space-y-1.5 pr-1" :class="scrollable ? 'h-[200px] overflow-y-auto' : ''" role="radiogroup" :aria-label="active.title">
          <button v-for="(option, index) in active.options || []" :key="index" type="button" role="radio"
            :aria-checked="!draft.useCustom && draft.selected === index" :disabled="!editable"
            class="group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-60 cursor-pointer disabled:cursor-default"
            :class="!draft.useCustom && draft.selected === index
              ? (isDark ? 'border-blue-500/60 bg-blue-500/15 shadow-[0_0_20px_-8px_rgba(59,130,246,0.9)]' : 'border-blue-200 bg-blue-50')
              : (isDark ? 'border-white/10 hover:border-blue-500/40 hover:bg-white/5' : 'border-gray-100 hover:border-blue-200 hover:bg-blue-50/50')"
            :data-choice-option="index" @click="selectOption(index)">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-colors"
              :class="!draft.useCustom && draft.selected === index
                ? 'bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.7)]'
                : (isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-100 text-gray-500')">{{ index + 1 }}</span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words"
              :class="isDark ? (draft.selected === index && !draft.useCustom ? 'text-white text-glow-white' : 'text-gray-200 text-glow-subtle') : ''">{{ option }}</span>
            <svg class="h-3.5 w-3.5 shrink-0 transition-colors" :class="!draft.useCustom && draft.selected === index ? 'text-blue-500' : (isDark ? 'text-gray-600' : 'text-gray-300')"
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
          </button>
        </div>
        <!-- 其他补充 = 与选项同形的整行输入：点行即键入，不再另开输入框 -->
        <div class="mt-1.5 flex items-center gap-3 rounded-xl border px-3 py-2.5 transition"
          :class="draft.useCustom
            ? (isDark ? 'border-blue-500/60 bg-blue-500/15 shadow-[0_0_20px_-8px_rgba(59,130,246,0.9)]' : 'border-blue-200 bg-blue-50')
            : (isDark ? 'border-white/10 hover:border-blue-500/40 hover:bg-white/5' : 'border-gray-100 hover:border-blue-200 hover:bg-blue-50/50')"
          role="presentation" data-testid="choice-custom-toggle" @click="activateCustom">
          <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors"
            :class="draft.useCustom ? 'bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.7)]' : (isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-100 text-gray-400')">
            <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
          </span>
          <!-- rows=1 + resize-none：外观是输入行，粘贴多行仍原样保留 -->
          <textarea ref="customInput" v-model="draft.custom" :disabled="!editable" rows="1"
            :aria-label="t('chat.choice.customAnswerPlaceholder')" :placeholder="t('chat.choice.customRowLabel')"
            class="h-5 min-w-0 flex-1 resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-gray-500"
            :class="isDark ? 'text-white caret-blue-400 text-glow-subtle' : 'text-gray-900'"
            data-testid="choice-custom-input" />
        </div>
      </template>
    </div>
    <footer v-if="pending.length || error" class="space-y-2 border-t px-4 py-3" :class="isDark ? 'border-white/10' : 'border-gray-100'">
      <p v-if="error" :class="['text-xs', CARD_ERROR_TEXT_CLASS]" role="alert">{{ error }}</p>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs" :class="isDark ? 'text-gray-400 text-glow-subtle' : 'text-gray-500'">{{ !ready ? t('chat.choice.groupPreparing') : (canSubmit ? t('chat.choice.groupProgress', { answered, total }) : t('chat.choice.groupHint')) }}</span>
        <CardActionButton tone="blue" :loading="submitting" :disabled="!canSubmit" :is-dark="isDark" data-testid="choice-submit-all" @click="submit">{{ t('chat.choice.submitAll') }}</CardActionButton>
      </div>
    </footer>
  </section>
</template>
