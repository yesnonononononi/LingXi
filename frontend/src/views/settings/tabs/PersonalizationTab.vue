<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import { usePersonalizationTab } from './usePersonalizationTab';

const { copy, config, styles, draft, loading, saving, error, saved, dirty, load, save } = usePersonalizationTab();
const styleOptions = computed(() => styles.value.map(style => ({ value: style.value, label: copy.value.styles[style.value] || style.label })));
const editing = ref<'title' | 'commonAgentName' | null>(null);
const identityInput = ref<HTMLInputElement | null>(null);
const instructionInput = ref<HTMLTextAreaElement | null>(null);
const editingInstruction = ref(false);
let instructionBeforeEdit = '';

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
}

async function submit() {
  await save();
  if (saved.value) {
    editing.value = null;
    editingInstruction.value = false;
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
          <textarea id="personalization-instruction" ref="instructionInput" v-model="draft.customInstruction" :readonly="!editingInstruction" :placeholder="copy.placeholder" class="personalization-input mt-4 w-full min-h-32 resize-y leading-relaxed" />
        </section>

        <div class="sticky bottom-0 flex items-center justify-end gap-3 bg-white/95 pt-3 pb-1 dark:bg-black/95">
          <span v-if="saved && !dirty" role="status" class="text-xs text-lx-muted">{{ copy.saved }}</span>
          <button type="submit" :disabled="!dirty || saving || loading" class="rounded-xl bg-gray-900 px-4 py-2.5 text-xs font-medium text-white transition hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">{{ saving ? copy.saving : copy.save }}</button>
        </div>
      </fieldset>
    </form>
  </div>
</template>

<style scoped>
@reference "../../../style.css";
.personalization-card { @apply rounded-2xl border border-gray-100 bg-gray-50/60 p-4 dark:border-white/10 dark:bg-white/[0.03]; }
.identity-row { @apply flex items-center justify-between gap-4; }
.identity-control { @apply w-52 min-w-0 shrink-0; }
.personalization-input { @apply rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-lx-primary-soft outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-200/60 dark:border-white/15 dark:bg-black/30 dark:focus:border-white/40 dark:focus:ring-white/10; }
@media (max-width: 640px) {
  .identity-row { @apply flex-col items-stretch gap-2.5; }
  .identity-control { @apply w-full; }
}
</style>
