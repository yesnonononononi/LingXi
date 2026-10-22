<script setup lang="ts">
import { computed, ref } from 'vue';
import { ModelAPI, ProviderAPI } from '../../../services/api';
import type { ProviderConfigVO } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import ModelVisionField from '../../../components/model/ModelVisionField.vue';
import ProviderIcon from '../../../components/model/ProviderIcon.vue';
import { useModelImportCopy } from './useModelImportCopy';

const props = defineProps<{ provider: ProviderConfigVO; existingNames: string[]; isDark: boolean }>();
const emit = defineEmits<{ back: []; edit: []; updated: [] }>();
const copy = useModelImportCopy();
const source = ref<'remote' | 'manual'>('remote');
const remote = ref<{ id: string }[]>([]);
const selected = ref<string[]>([]);
const manual = ref('');
const search = ref('');
const loading = ref(false);
const attempted = ref(false);
const failed = ref(false);
const saving = ref(false);
const error = ref('');
const vision = ref(false);
const result = ref<{ addedCount: number; skippedNames: string[] } | null>(null);
const existing = computed(() => new Set(props.existingNames));
const ready = computed(() => !!props.provider.baseUrl?.trim() && !!props.provider.credentialConfigured);
const visible = computed(() => remote.value.filter(model => model.id.toLowerCase().includes(search.value.trim().toLowerCase())));
const names = computed(() => source.value === 'remote' ? selected.value
  : [...new Set(manual.value.split(/[\n,，]+/).map(name => name.trim()).filter(Boolean))]);
const newNames = computed(() => names.value.filter(name => !existing.value.has(name)));
const invalid = computed(() => names.value.length > 200 ? copy.value.overLimit
  : names.value.some(name => name.length > 100) ? copy.value.nameTooLong : '');

async function fetchModels() {
  loading.value = true;
  failed.value = false;
  attempted.value = true;
  try {
    const response = await ProviderAPI.discoverModels({ providerConfigId: props.provider.id });
    if (!isOk(response.code) || !response.data) throw new Error('模型发现失败');
    remote.value = response.data;
    selected.value = selected.value.filter(name => remote.value.some(model => model.id === name));
  } catch {
    remote.value = [];
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

function selectVisible() {
  selected.value = [...new Set([...selected.value, ...visible.value.filter(model => !existing.value.has(model.id)).map(model => model.id)])];
}

async function save() {
  if (saving.value || !ready.value || invalid.value || !newNames.value.length) return;
  saving.value = true;
  error.value = '';
  try {
    const response = await ModelAPI.batchAdd({ providerConfigId: props.provider.id, modelNames: names.value, vision: vision.value });
    if (!isOk(response.code) || !response.data) throw new Error('模型添加失败');
    result.value = response.data;
    selected.value = [];
    manual.value = '';
    emit('updated');
  } catch {
    error.value = copy.value.error;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="model-import" :class="{ 'import-dark': isDark }" data-testid="batch-models">
    <header class="import-heading">
      <button type="button" class="import-back" :disabled="saving" @click="emit('back')" :aria-label="copy.back">‹</button>
      <div><h4>{{ copy.batch }}</h4><p>{{ copy.intro }}</p></div>
    </header>
    <div class="import-provider">
      <ProviderIcon :name="provider.name" :icon="provider.icon" :size="28" />
      <div class="min-w-0"><strong>{{ provider.name }}</strong><p class="truncate">{{ provider.baseUrl || '—' }}</p></div>
      <button type="button" class="import-link" :disabled="saving" @click="emit('edit')">{{ copy.edit }}</button>
    </div>
    <p class="import-help">{{ copy.connectionHint }}</p>

    <div v-if="!ready" class="import-message" role="alert">{{ copy.missing }}</div>
    <div v-else-if="result" class="import-success" role="status">
      <strong>{{ copy.done }} {{ result.addedCount }} {{ copy.unit }}<span v-if="result.skippedNames.length"> · {{ copy.skipped }} {{ result.skippedNames.length }}</span></strong>
      <p>{{ copy.doneHint }}</p>
      <div class="import-actions"><button type="button" @click="result = null">{{ copy.continue }}</button><button type="button" class="primary" @click="emit('back')">{{ copy.back }}</button></div>
    </div>
    <template v-else>
      <div class="import-tabs" role="tablist" :aria-label="copy.selection">
        <button type="button" role="tab" :aria-selected="source === 'remote'" :disabled="saving" @click="source = 'remote'">{{ copy.remote }}</button>
        <button type="button" role="tab" :aria-selected="source === 'manual'" :disabled="saving" @click="source = 'manual'">{{ copy.manual }}</button>
      </div>
      <div v-if="source === 'remote'" class="import-remote">
        <div class="import-toolbar">
          <input v-model="search" :placeholder="copy.search" :aria-label="copy.search" :disabled="!remote.length || saving" />
          <button type="button" :disabled="loading || saving || !ready" @click="fetchModels">{{ loading ? copy.fetching : attempted ? copy.retry : copy.fetch }}</button>
        </div>
        <div v-if="loading" class="import-empty" role="status">{{ copy.fetching }}</div>
        <div v-else-if="failed" class="import-empty import-failure" role="alert">
          <strong>{{ copy.failure }}</strong><p>{{ copy.failureHint }}</p>
          <button type="button" class="import-link" @click="source = 'manual'">{{ copy.manual }} →</button>
        </div>
        <div v-else-if="!remote.length" class="import-empty"><strong>{{ attempted ? copy.empty : copy.initial }}</strong><p v-if="!attempted">{{ copy.initialHint }}</p></div>
        <template v-else>
          <div class="import-selection"><span>{{ copy.available }} {{ remote.length }} · {{ copy.selected }} {{ selected.length }}</span><button type="button" class="import-link" :disabled="saving" @click="selectVisible">{{ copy.selectAll }}</button><button type="button" class="import-link" :disabled="saving" @click="selected = []">{{ copy.clear }}</button></div>
          <div class="import-list">
            <label v-for="model in visible" :key="model.id" :class="{ 'is-selected': selected.includes(model.id), 'is-existing': existing.has(model.id) }">
              <input v-model="selected" type="checkbox" :value="model.id" :disabled="existing.has(model.id) || saving" />
              <span>{{ model.id }}</span><small v-if="existing.has(model.id)">{{ copy.existing }}</small>
            </label>
            <p v-if="!visible.length" class="import-empty">{{ copy.noMatch }}</p>
          </div>
        </template>
      </div>
      <div v-else class="import-manual">
        <label for="batch-model-names">{{ copy.names }}</label>
        <p class="import-help">{{ copy.namesHelp }}</p>
        <textarea id="batch-model-names" v-model="manual" :placeholder="copy.placeholder" :disabled="saving" spellcheck="false" />
        <span class="import-help">{{ copy.selected }} {{ newNames.length }} {{ copy.unit }}<span v-if="names.length > newNames.length"> · {{ copy.existing }} {{ names.length - newNames.length }}</span></span>
      </div>
      <p class="import-help">{{ copy.limit }}</p>
      <ModelVisionField v-model="vision" :is-dark="isDark" />
      <p v-if="error || invalid" class="import-error" role="alert">{{ error || invalid }}</p>
      <footer class="import-actions">
        <button type="button" :disabled="saving" @click="emit('back')">{{ copy.back }}</button>
        <button type="button" class="primary" :disabled="saving || !ready || !newNames.length || !!invalid" @click="save">{{ saving ? copy.adding : `${copy.add} ${newNames.length} ${copy.unit}` }}</button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
/* 沿用设置页的字体与色阶，列表固定高度，避免模型较多时挤出提交入口。 */
.model-import { --im-text:#18181b; --im-muted:#71717a; --im-line:#e4e4e7; --im-soft:#fafafa; --im-bg:#fff; --im-accent:#2563eb; color:var(--im-text); font-size:12px; display:grid; gap:14px; }
.import-dark { --im-text:#f4f4f5; --im-muted:#a1a1aa; --im-line:#303035; --im-soft:#111113; --im-bg:#050505; --im-accent:#38bdf8; }
.import-heading { display:flex; align-items:center; gap:10px; }
h4 { font-size:16px; font-weight:650; margin:0; letter-spacing:-.3px; }
p { margin:0; }
.import-heading p { margin-top:4px; color:var(--im-muted); }
button { cursor:pointer; transition:background .15s; }
button:disabled { opacity:.45; cursor:not-allowed; }
.import-back { font-size:26px; width:28px; height:36px; border-radius:8px; }
.import-provider { border:1px solid var(--im-line); border-radius:12px; padding:12px; display:flex; align-items:center; gap:10px; background:var(--im-soft); }
.import-provider strong { font-size:13px; font-weight:600; }
.import-provider p { color:var(--im-muted); font-size:11px; margin-top:3px; }
.import-provider .import-link { margin-left:auto; flex-shrink:0; }
.import-help { color:var(--im-muted); font-size:11px; line-height:1.6; }
.import-tabs { display:flex; gap:20px; border-bottom:1px solid var(--im-line); }
.import-tabs button { padding:8px 0 10px; color:var(--im-muted); border-bottom:2px solid transparent; font-weight:550; }
.import-tabs button[aria-selected=true] { color:var(--im-accent); border-bottom-color:var(--im-accent); }
.import-toolbar { display:flex; gap:8px; }
.import-toolbar input { flex:1; min-width:0; }
.import-toolbar button,.import-actions button { padding:8px 12px; border:1px solid var(--im-line); border-radius:9px; font-weight:550; white-space:nowrap; }
.import-toolbar input,textarea { border:1px solid var(--im-line); border-radius:9px; padding:9px 11px; outline:none; color:var(--im-text); background:var(--im-bg); }
input:focus,textarea:focus { border-color:var(--im-accent); }
button:focus-visible { outline:2px solid var(--im-accent); outline-offset:3px; }
.import-empty { padding:32px 12px; text-align:center; color:var(--im-muted); line-height:1.7; }
.import-empty strong { font-weight:550; color:var(--im-text); }
.import-empty p { font-size:11px; margin-top:6px; }
.import-failure { background:var(--im-soft); border:1px dashed var(--im-line); border-radius:10px; margin-top:12px; }
.import-failure button { margin-top:12px; }
.import-selection { display:flex; align-items:center; gap:12px; color:var(--im-muted); font-size:11px; padding:12px 0 8px; flex-wrap:wrap; }
.import-selection span { margin-right:auto; }
.import-link { color:var(--im-accent); font-size:11px; }
.import-list { max-height:212px; overflow:auto; border:1px solid var(--im-line); border-radius:10px; }
.import-list label { display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer; border-bottom:1px solid var(--im-line); }
.import-list label:last-child { border-bottom:none; }
.import-list label:hover { background:var(--im-soft); }
.import-list input { accent-color:var(--im-accent); }
.import-list span { font-family:ui-monospace,monospace; overflow-wrap:anywhere; min-width:0; }
.import-list small { margin-left:auto; white-space:nowrap; color:var(--im-muted); }
.import-list .is-existing { opacity:.6; cursor:default; }
.import-list .is-selected { background:color-mix(in srgb,var(--im-accent) 6%,var(--im-bg)); }
.import-manual { display:grid; gap:8px; }
.import-manual>label { font-weight:550; }
textarea { width:100%; min-height:156px; resize:vertical; font-family:ui-monospace,monospace; line-height:1.8; }
.import-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:12px; border-top:1px solid var(--im-line); }
.import-actions .primary { background:#2563eb; border-color:#2563eb; color:white; }
.import-dark .primary { background:#0284c7; border-color:#0284c7; }
.import-error,.import-message { color:#dc2626; font-size:12px; }
.import-success { padding:24px 12px; text-align:center; background:var(--im-soft); border-radius:12px; }
.import-success strong { color:var(--im-accent); font-size:15px; }
.import-success p { padding:10px 0 20px; color:var(--im-muted); }
@media(max-width:480px) { .import-toolbar { flex-wrap:wrap; } .import-toolbar input { flex-basis:100%; } .import-actions button { flex:1; } }
</style>
