<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import {usePersonalizationTab} from './usePersonalizationTab';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_SCOPES,
  formatShortcutLabel,
  shortcutFromEvent,
  validateShortcutText,
  type ShortcutAction,
} from '../../../utils/shortcuts';

const { copy, config, styles, draft, loading, saving, error, saved, dirty, shortcutConflicts, shortcutsBlocked, load, save } = usePersonalizationTab();
const styleOptions = computed(() => styles.value.map(style => ({ value: style.value, label: copy.value.styles[style.value] || style.label })));
const editing = ref<'title' | 'commonAgentName' | null>(null);
const identityInput = ref<HTMLInputElement | null>(null);
const instructionInput = ref<HTMLTextAreaElement | null>(null);
const editingInstruction = ref(false);
let instructionBeforeEdit = '';
/** 展示用的平台名：macOS 走符号，其它平台走 Ctrl/Alt 全称。 */
const platform = typeof window === 'undefined' ? undefined : window.electronAPI?.platform;
/** 正在录制的动作；null 表示没有在录制。 */
const recording = ref<ShortcutAction | null>(null);
/** 录制过程中按下的键不被接受时的提示（就地显示，不打断其它行的编辑）。 */
const recorderProblem = ref('');

const conflictText = computed<string>(() => shortcutConflicts.value
  .map(conflict => `${conflict.actions.map(action => copy.value.shortcutLabels[action]).join(' / ')} → ${formatShortcutLabel(conflict.text, platform)}`)
  .join('；'));

function syncInstructionHeight() {
  const element = instructionInput.value;
  if (!element) return;
  element.style.height = 'auto';
  const target = Math.min(Math.max(element.scrollHeight, 128), 320);
  element.style.height = `${target}px`;
}

watch(() => config.value, async (loaded) => {
  if (loaded) {
    await nextTick();
    syncInstructionHeight();
  }
}, { immediate: true });

async function editIdentity(field: 'title' | 'commonAgentName') {
  editing.value = field;
  await nextTick();
  identityInput.value?.focus();
}

async function editInstruction() {
  instructionBeforeEdit = draft.customInstruction ?? '';
  editingInstruction.value = true;
  await nextTick();
  instructionInput.value?.focus();
}

function cancelInstruction() {
  draft.customInstruction = instructionBeforeEdit;
  editingInstruction.value = false;
  nextTick(syncInstructionHeight);
}

function displayShortcut(action: ShortcutAction): string {
  return formatShortcutLabel(draft.shortcuts[action], platform);
}

function startRecording(action: ShortcutAction) {
  recorderProblem.value = '';
  recording.value = action;
}

function cancelRecording() {
  recording.value = null;
  recorderProblem.value = '';
}

/**
 * 录制按键。
 *
 * <p>必须 `stopPropagation`：窗口级监听着同一份绑定，不拦住的话录制 Mod+B 会顺手把侧边栏收起来。
 * 只按下修饰键时返回 null，不当成一个组合键（否则第一次按 Ctrl 就被记成 Ctrl）。</p>
 */
function onRecorderKeydown(action: ShortcutAction, event: KeyboardEvent) {
  if (recording.value !== action) return;
  event.preventDefault();
  event.stopPropagation();
  const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (bare && event.key === 'Escape') {
    cancelRecording();
    return;
  }
  const text = shortcutFromEvent(event);
  if (!text) return;
  const problem = validateShortcutText(text, SHORTCUT_SCOPES[action]);
  if (problem) {
    recorderProblem.value = copy.value.shortcutProblems[problem];
    return;
  }
  draft.shortcuts[action] = text;
  cancelRecording();
}

function resetShortcut(action: ShortcutAction) {
  draft.shortcuts[action] = DEFAULT_SHORTCUTS[action];
  cancelRecording();
}

function resetAllShortcuts() {
  for (const action of SHORTCUT_ACTIONS) draft.shortcuts[action] = DEFAULT_SHORTCUTS[action];
  cancelRecording();
}

async function submit() {
  await save();
  if (saved.value) {
    editing.value = null;
    editingInstruction.value = false;
    nextTick(syncInstructionHeight);
  }
}
</script>

<template>
  <div class="personalization space-y-4">
    <div v-if="error" role="alert" class="rounded-xl border border-red-300/40 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
      <p>{{ error }}</p>
      <button v-if="!config" type="button" class="mt-2 underline cursor-pointer" :disabled="loading" @click="load">{{ copy.retry }}</button>
    </div>
    <div v-if="loading && !config" role="status" class="py-12 text-center text-xs text-lx-muted">{{ copy.loading }}</div>
    <form v-if="config" class="space-y-4" @submit.prevent="submit">
      <fieldset :disabled="saving || loading" class="space-y-4 min-w-0">
        <section class="personalization-card space-y-5">
          <div v-for="field in (['title', 'commonAgentName'] as const)" :key="field" class="identity-row">
            <label :for="`personalization-${field}`" class="text-xs font-semibold text-lx-primary-soft">{{ field === 'title' ? copy.title : copy.name }}</label>
            <input v-if="editing === field" :id="`personalization-${field}`" :ref="element => { identityInput = element as HTMLInputElement | null; }" v-model="draft[field]" class="personalization-input identity-control" :aria-label="field === 'title' ? copy.title : copy.name" @blur="editing = null" @keydown.enter.prevent="editing = null" />
            <button v-else :id="`personalization-${field}`" type="button" class="identity-control personalization-input text-right cursor-pointer" @click="editIdentity(field)">
              <span :class="draft[field] ? 'text-lx-primary-soft' : 'text-lx-faint'">{{ draft[field] || copy.empty }}</span>
            </button>
          </div>
        </section>

        <section class="personalization-card identity-row">
          <div>
            <label for="personalization-style" class="text-xs font-semibold text-lx-primary-soft">{{ copy.style }}</label>
            <p class="mt-1.5 text-xs leading-relaxed text-lx-muted">{{ copy.styleHint }}</p>
          </div>
          <div class="identity-control">
            <SettingsSelect id="personalization-style" v-model="draft.replyStyle" :label="copy.style"
              :options="styleOptions" :disabled="saving || loading" class="w-full" />
          </div>
        </section>

        <section class="personalization-card">
          <div class="flex items-start justify-between gap-4">
            <div>
              <label for="personalization-instruction" class="text-xs font-semibold text-lx-primary-soft">{{ copy.instruction }}</label>
              <p class="mt-1.5 text-xs leading-relaxed text-lx-muted">{{ copy.instructionHint }}</p>
            </div>
            <button type="button" class="personalization-input shrink-0 px-3 cursor-pointer" @click="editingInstruction ? cancelInstruction() : editInstruction()">{{ editingInstruction ? copy.cancel : copy.edit }}</button>
          </div>
          <textarea
            id="personalization-instruction"
            ref="instructionInput"
            v-model="draft.customInstruction"
            :readonly="!editingInstruction"
            :placeholder="copy.placeholder"
            :class="[
              'personalization-input mt-4 w-full min-h-32 max-h-80 leading-relaxed overflow-y-auto',
              editingInstruction ? 'resize-y' : 'resize-none'
            ]"
          />
        </section>

        <section class="personalization-card space-y-3">
          <div class="flex items-start justify-between gap-4">
            <div>
              <span class="text-xs font-semibold text-lx-primary-soft">{{ copy.shortcuts }}</span>
              <p class="mt-1.5 text-xs leading-relaxed text-lx-muted">{{ copy.shortcutsHint }}</p>
            </div>
            <button type="button" data-test="shortcut-reset-all" class="personalization-input shrink-0 px-3 cursor-pointer" @click="resetAllShortcuts">{{ copy.shortcutResetAll }}</button>
          </div>
          <div v-for="action in SHORTCUT_ACTIONS" :key="action" class="identity-row">
            <span class="text-xs text-lx-primary-soft">
              {{ copy.shortcutLabels[action] }}
              <em class="ml-1.5 not-italic text-lx-faint">{{ copy.shortcutScopes[SHORTCUT_SCOPES[action]] }}</em>
            </span>
            <div class="identity-control flex items-center gap-2">
              <button
                type="button"
                :data-test="`shortcut-${action}`"
                :aria-label="copy.shortcutLabels[action]"
                :aria-pressed="recording === action"
                :class="[
                  'personalization-input flex-1 min-w-0 cursor-pointer text-center tabular-nums',
                  recording === action ? 'border-blue-400 ring-2 ring-blue-200/60 dark:border-blue-400/70 dark:ring-blue-500/20' : ''
                ]"
                @click="recording === action ? cancelRecording() : startRecording(action)"
                @blur="recording === action && cancelRecording()"
                @keydown="onRecorderKeydown(action, $event)"
              >{{ recording === action ? copy.shortcutRecording : displayShortcut(action) }}</button>
              <button type="button" :aria-label="`${copy.shortcutReset} ${copy.shortcutLabels[action]}`" class="shrink-0 text-xs text-lx-muted underline cursor-pointer" @click="resetShortcut(action)">{{ copy.shortcutReset }}</button>
            </div>
          </div>
          <p v-if="recorderProblem" role="alert" class="text-xs text-red-600 dark:text-red-400">{{ recorderProblem }}</p>
          <p v-if="shortcutConflicts.length" role="alert" data-test="shortcut-conflict" class="text-xs text-red-600 dark:text-red-400">{{ copy.shortcutConflict }}：{{ conflictText }}</p>
        </section>

        <div class="flex items-center justify-end gap-3 pt-2">
          <span v-if="saved && !dirty" role="status" class="text-xs text-lx-muted">{{ copy.saved }}</span>
          <button type="submit" :disabled="!dirty || saving || loading || shortcutsBlocked" class="rounded-xl bg-zinc-900 px-4 py-2.5 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">{{ saving ? copy.saving : copy.save }}</button>
        </div>
      </fieldset>
    </form>
  </div>
</template>

<style scoped>
@reference "../../../style.css";
.personalization-card { @apply rounded-2xl border border-zinc-100 bg-zinc-50/60 p-4 dark:border-white/10 dark:bg-white/[0.03]; }
.identity-row { @apply flex items-center justify-between gap-4; }
.identity-control { @apply w-52 min-w-0 shrink-0; }
.personalization-input { @apply rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-lx-primary-soft outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200/60 dark:border-white/15 dark:bg-black/30 dark:focus:border-white/40 dark:focus:ring-white/10; }
@media (max-width: 640px) {
  .identity-row { @apply flex-col items-stretch gap-2.5; }
  .identity-control { @apply w-full; }
}
</style>
