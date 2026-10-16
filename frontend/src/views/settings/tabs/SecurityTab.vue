<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { SecurityRulesAPI } from '../../../services/securityRules';
import type { SecurityAction, SecurityCategory, SecurityRule, SecurityRuleView } from '../../../services/securityRules';
import { isOk } from '../../../utils/api';
import { useSecurityCopy } from './securityCopy';
const copy = useSecurityCopy();
const category = ref<SecurityCategory>('files');
const tables = reactive<Partial<Record<SecurityCategory, SecurityRuleView>>>({});
const dirty = reactive<Partial<Record<SecurityCategory, boolean>>>({});
const busy = ref(false);
const error = ref('');
const notice = ref('');
const pattern = ref('');
const matchType = ref<'PROGRAM' | 'PREFIX'>('PREFIX');
const current = computed(() => tables[category.value]);
const categories: SecurityCategory[] = ['files', 'terminal', 'net'];
const panel = 'rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-50/70 dark:bg-white/[0.025] p-4';
const control = 'rounded-lg border border-gray-200 dark:border-white/15 bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-200 px-2 py-1.5 text-xs';
const button = 'rounded-lg border border-gray-200 dark:border-white/15 px-2.5 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
function label(action: SecurityAction) { return copy.value[action === 'ALLOW' ? 'allow' : action === 'ASK' ? 'ask' : 'deny']; }
function validate(view: SecurityRuleView | undefined, selected: SecurityCategory): asserts view is SecurityRuleView {
  if (!view || !['NATIVE_NEXT_WORKSPACE', 'IMMEDIATE', 'OUTBOUND_OPEN'].includes(view.activation) || view.category !== selected || typeof view.revision !== 'string' || !/^(0|[1-9]\d*)$/.test(view.revision)
    || !Array.isArray(view.rules) || !Array.isArray(view.supportedActions) || !view.supportedActions.length
    || view.supportedActions.some(action => !['ALLOW', 'ASK', 'DENY'].includes(action))
    || view.rules.some(rule => typeof rule.pattern !== 'string' || typeof rule.enabled !== 'boolean')) throw new Error(copy.value.contractError);
}
async function load(selected = category.value) {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await SecurityRulesAPI.current(selected);
    if (!isOk(response.code)) throw new Error(copy.value.loadError);
    validate(response.data, selected); tables[selected] = response.data; dirty[selected] = false;
  } catch { error.value = copy.value.loadError; }
  finally { busy.value = false; }
}
async function select(selected: SecurityCategory) {
  if (busy.value) return;
  category.value = selected; pattern.value = ''; error.value = ''; notice.value = '';
  if (!tables[selected]) await load(selected);
}
function change() { dirty[category.value] = true; notice.value = ''; error.value = ''; }
function changeFile(rule: SecurityRule) { rule.write = rule.read; rule.delete = rule.read; change(); }
function add() {
  if (!pattern.value.trim()) { error.value = copy.value.invalidPattern; return; }
  if (!current.value || category.value === 'net') return;
  const file = category.value === 'files';
  const rule: SecurityRule = { pattern: pattern.value.trim(), matchType: file ? 'PATH' : matchType.value,
    read: file ? 'DENY' : null, write: file ? 'DENY' : null, delete: file ? 'DENY' : null,
    action: file ? null : 'ASK', enabled: true, preset: null };
  current.value.rules.unshift(rule); pattern.value = ''; change(); notice.value = copy.value.added;
}
function move(index: number, direction: number) {
  const rules = current.value?.rules;
  if (!rules || !rules[index] || !rules[index + direction]) return;
  const removed = rules.splice(index, 1)[0]!; rules.splice(index + direction, 0, removed); change();
}
function remove(index: number) { current.value?.rules.splice(index, 1); change(); }
async function reset() {
  if (!current.value || category.value === 'net') return;
  busy.value = true; error.value = '';
  try {
    const response = await SecurityRulesAPI.defaults(category.value);
    if (!isOk(response.code) || !Array.isArray(response.data)) throw new Error(copy.value.resetError);
    current.value.rules = response.data; change();
  } catch { error.value = copy.value.resetError; }
  finally { busy.value = false; }
}
async function save() {
  const table = current.value; const selected = category.value;
  if (!table || !dirty[selected]) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await SecurityRulesAPI.save(selected, table.revision, table.rules);
    if (!isOk(response.code)) throw new Error(copy.value.saveError);
    validate(response.data, selected); tables[selected] = response.data; dirty[selected] = false; notice.value = copy.value.saved;
  } catch { error.value = copy.value.saveError; }
  finally { busy.value = false; }
}
onMounted(() => load());
</script>
<template>
  <div class="space-y-4 min-w-0 text-gray-800 dark:text-zinc-100" data-testid="security-center">
    <nav class="flex flex-wrap gap-1 rounded-xl bg-gray-100 dark:bg-white/5 p-1" :aria-label="copy.page">
      <button v-for="item in categories" :key="item" type="button" :data-testid="`security-tab-${item}`" :disabled="busy" :aria-pressed="category === item" @click="select(item)"
        :class="['flex-1 min-w-fit rounded-lg px-3 py-2 text-xs font-medium transition', category === item ? 'bg-white dark:bg-zinc-800 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white']">{{ copy[item] }}</button>
    </nav>
    <section :class="panel">
      <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="text-xs font-semibold">{{ copy[category] }}</h4>
        <button v-if="category !== 'net' && current" type="button" :class="button" :disabled="busy" @click="reset" data-testid="security-reset">{{ copy.defaults }}</button></div>
      <p class="mt-2 text-xs leading-6 text-gray-500 dark:text-zinc-400">{{ copy[category === 'files' ? 'fileHint' : category === 'terminal' ? 'terminalHint' : 'netHint'] }}</p>
      <details v-if="category === 'files'" class="mt-2 text-[11px] leading-5 text-gray-500 dark:text-zinc-400"><summary class="cursor-pointer">{{ copy.scope }}</summary><p class="mt-2">{{ copy.fileLimits }}</p></details>
    </section>
    <div v-if="error" role="alert" class="text-xs leading-5 text-red-600 dark:text-red-400" data-testid="security-error">{{ error }}
      <button type="button" :class="[button, 'ml-2']" :disabled="busy" @click="load()">{{ copy.retry }}</button></div>
    <p v-if="busy" role="status" class="text-xs text-gray-500">{{ copy.loading }}</p>
    <template v-if="current">
      <p role="status" class="text-xs leading-6 text-gray-500 dark:text-zinc-400">{{ copy[category === 'files' ? 'fileActive' : category === 'terminal' ? 'terminalActive' : 'mcpScope'] }}</p>
      <section v-if="category === 'net'" :class="panel" data-testid="security-net-allow">
        <div class="flex items-center gap-2 text-xs font-semibold"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500" />{{ copy.netStatus }}</div>
        <p class="mt-2 text-xs leading-6 text-gray-500 dark:text-zinc-400">{{ copy.netDetail }}</p>
      </section>
      <fieldset v-else :disabled="busy" :class="[panel, 'min-w-0']">
        <legend class="sr-only">{{ copy.rules }}</legend>
        <form class="flex flex-wrap gap-2" @submit.prevent="add">
          <select v-if="category === 'terminal'" v-model="matchType" :class="control" :aria-label="copy.prefix"><option value="PREFIX">{{ copy.prefix }}</option><option value="PROGRAM">{{ copy.program }}</option></select>
          <input v-model="pattern" :class="[control, 'min-w-0 flex-1 w-full']" :placeholder="copy[category === 'files' ? 'filePlaceholder' : 'terminalPlaceholder']" :aria-label="copy.add" data-testid="security-pattern" />
          <button type="submit" :class="button" data-testid="security-add">+ {{ copy.add }}</button>
        </form>
        <p class="mt-3 mb-1 text-[11px] leading-5 text-gray-400 dark:text-zinc-500">{{ copy.moveHint }}</p>
        <div v-if="!current.rules.length" class="py-6 text-center text-xs text-gray-400">{{ copy.empty }}</div>
        <div v-for="(rule, index) in current.rules" :key="index" class="py-3 border-t border-gray-200/80 dark:border-white/10 space-y-2" data-testid="security-rule">
          <div class="flex items-start gap-2 min-w-0">
            <span class="shrink-0 text-[10px] border border-gray-200 dark:border-white/15 rounded px-1.5 py-0.5 text-gray-500 dark:text-zinc-400">{{ rule.preset ? copy.preset : copy.custom }}</span>
            <code class="min-w-0 flex-1 text-xs leading-5 [overflow-wrap:anywhere]">{{ rule.pattern }}</code>
            <input type="checkbox" v-model="rule.enabled" @change="change" :aria-label="copy.enabled" />
            <button type="button" :class="button" :aria-label="copy.up" :disabled="index === 0" @click="move(index, -1)">↑</button>
            <button type="button" :class="button" :aria-label="copy.down" :disabled="index === current.rules.length - 1" @click="move(index, 1)">↓</button>
            <button type="button" :class="button" :aria-label="copy.remove" @click="remove(index)">×</button>
          </div>
          <div class="flex justify-end flex-wrap gap-2">
            <label v-if="category === 'files'" class="flex items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-400">{{ copy.access }}
              <select v-model="rule.read" @change="changeFile(rule)" :class="control" :aria-label="`${rule.pattern} ${copy.access}`"><option v-for="action in current.supportedActions" :key="action" :value="action">{{ label(action) }}</option></select>
            </label>
            <select v-else v-model="rule.action" @change="change" :class="control" :aria-label="rule.pattern"><option v-for="action in current.supportedActions" :key="action" :value="action">{{ label(action) }}</option></select>
          </div>
        </div>
      </fieldset>
      <div v-if="category !== 'net'" class="sticky bottom-0 flex flex-wrap justify-between items-center gap-2 pt-3 pb-1 bg-white dark:bg-black">
        <span role="status" class="text-[11px] text-gray-500 dark:text-zinc-400">{{ notice || (dirty[category] ? copy.dirty : '') }}</span>
        <button type="button" :disabled="!dirty[category] || busy" :class="[button, 'font-medium px-4']" @click="save" data-testid="security-save">{{ copy.save }}</button>
      </div>
    </template>
  </div>
</template>
