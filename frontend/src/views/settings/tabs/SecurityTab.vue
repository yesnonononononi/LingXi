<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { SecurityRulesAPI } from '../../../services/securityRules';
import type { SecurityAction, SecurityCategory, SecurityRule, SecurityRuleView } from '../../../services/securityRules';
import { isOk } from '../../../utils/api';
import { useI18n } from '../../../i18n';
import type { AgentAccessMode, CommandApprovalPolicyType } from '../../../types/chat';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import { useSecurityCopy } from './securityCopy';
import { useSandboxSettings } from './useSandboxSettings';

const emit = defineEmits<{ (e: 'modelUpdated'): void }>();
const copy = useSecurityCopy();
const { t } = useI18n();
const {
  sandboxState,
  isSavingEnv,
  setSandboxEnabled,
  sandboxStatus,
  isCheckingSandbox,
  sandboxError,
  sandboxNotice,
  checkSandboxService,
  accessMode,
  accessModeOptions,
  handleSelectAccessMode,
  commandApprovalPolicy,
  commandApprovalPolicyOptions,
  handleSelectCommandApprovalPolicy,
} = useSandboxSettings(() => emit('modelUpdated'));

/* 首层是策略清单，第二层才是某一类规则的编辑器 */
const view = ref<'list' | SecurityCategory>('list');
const category = ref<SecurityCategory>('files');
const tables = reactive<Partial<Record<SecurityCategory, SecurityRuleView>>>({});
const dirty = reactive<Partial<Record<SecurityCategory, boolean>>>({});
/* 初值就是 true：首帧直接铺骨架，否则 onMounted 之前会先闪一帧空卡片再切到骨架 */
const busy = ref(true);
const error = ref('');
const notice = ref('');
const pattern = ref('');
const matchType = ref<'PROGRAM' | 'PREFIX'>('PREFIX');
const showScope = ref(false);
const current = computed(() => tables[category.value]);
const categories: SecurityCategory[] = ['files', 'terminal', 'net'];
const categoryDesc = { files: 'filesDesc', terminal: 'terminalDesc', net: 'netDesc' } as const;
const hint = computed(() => copy.value[category.value === 'files' ? 'fileHint' : category.value === 'terminal' ? 'terminalHint' : 'netHint']);
const activeHint = computed(() => copy.value[category.value === 'files' ? 'fileActive' : category.value === 'terminal' ? 'terminalActive' : 'mcpScope']);
const sandboxStateLabel = computed(() => copy.value[sandboxState.value === 'ON' ? 'sandboxOn' : sandboxState.value === 'OFF' ? 'sandboxOff' : 'sandboxUnset']);

/* 刚添加的规则：入列时闪一次高亮。用对象本身标记，规则不入库任何前端私有字段；
   离开分类时清空，否则整列表重挂会让旧标记的某一行又闪一次。 */
const freshRule = ref<SecurityRule | null>(null);
/* 规则对象到渲染 key 的映射：列表增删要靠真实身份重排，否则 index 复用的节点不会播入场动画。
   用 WeakMap 而不是给规则加 id 字段 —— 规则会被原样提交给后端。 */
const ruleKeys = new WeakMap<SecurityRule, number>();
let keySeed = 0;
function resolveRuleKey(rule: SecurityRule): number {
  const existing = ruleKeys.get(rule);
  if (existing !== undefined) return existing;
  keySeed += 1; ruleKeys.set(rule, keySeed);
  return keySeed;
}

/* 卡片 / 控件 / 按钮：与设置页其它 tab 同一套圆角与配色（卡片 2xl、控件 xl、图标按钮 lg） */
const panel = 'rounded-2xl border border-gray-100 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.03] p-4';
const control = 'rounded-xl border border-gray-200 dark:border-white/15 bg-white dark:bg-black/30 text-lx-secondary px-3 py-1.5 text-xs outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-200/60 dark:focus:border-white/40 dark:focus:ring-white/10';
const button = 'rounded-xl border border-gray-200 dark:border-white/15 px-3 py-1.5 text-xs font-medium transition cursor-pointer hover:bg-black/5 active:scale-[0.97] dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100';
const primary = 'rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition cursor-pointer hover:bg-blue-500 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100';
const iconButton = 'grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-gray-200 text-lx-muted transition cursor-pointer dark:border-white/15 hover:border-gray-300 hover:bg-black/5 hover:text-gray-900 dark:hover:border-white/25 dark:hover:bg-white/10 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent';
const stateChip = 'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium';
function label(action: SecurityAction) { return copy.value[action === 'ALLOW' ? 'allow' : action === 'ASK' ? 'ask' : 'deny']; }
function validate(table: SecurityRuleView | undefined, selected: SecurityCategory): asserts table is SecurityRuleView {
  if (!table || !['NATIVE_NEXT_WORKSPACE', 'IMMEDIATE', 'OUTBOUND_OPEN'].includes(table.activation) || table.category !== selected || typeof table.revision !== 'string' || !/^(0|[1-9]\d*)$/.test(table.revision)
    || !Array.isArray(table.rules) || !Array.isArray(table.supportedActions) || !table.supportedActions.length
    || table.supportedActions.some(action => !['ALLOW', 'ASK', 'DENY'].includes(action))
    || table.rules.some(rule => typeof rule.pattern !== 'string' || typeof rule.enabled !== 'boolean')) throw new Error(copy.value.contractError);
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
async function open(selected: SecurityCategory) {
  if (busy.value) return;
  category.value = selected; view.value = selected;
  pattern.value = ''; error.value = ''; notice.value = ''; freshRule.value = null;
  if (!tables[selected]) await load(selected);
}
function back() {
  if (busy.value) return;
  view.value = 'list'; error.value = ''; notice.value = '';
}
function change() { dirty[category.value] = true; notice.value = ''; error.value = ''; }
function changeFile(rule: SecurityRule) { rule.write = rule.read; rule.delete = rule.read; change(); }
function setAccess(rule: SecurityRule, value: string) { rule.read = value as SecurityAction; changeFile(rule); }
function setAction(rule: SecurityRule, value: string) { rule.action = value as SecurityAction; change(); }
/* 下拉回传的是字符串，收窄成联合类型这件事放在这里做，模板里不写类型断言 */
function selectMatchType(value: string) { matchType.value = value === 'PROGRAM' ? 'PROGRAM' : 'PREFIX'; }
function selectAccessMode(value: string) { void handleSelectAccessMode(value as AgentAccessMode); }
function selectCommandPolicy(value: string) { void handleSelectCommandApprovalPolicy(value as CommandApprovalPolicyType); }
function add() {
  if (!pattern.value.trim()) { error.value = copy.value.invalidPattern; return; }
  if (!current.value || category.value === 'net') return;
  const file = category.value === 'files';
  const rule: SecurityRule = { pattern: pattern.value.trim(), matchType: file ? 'PATH' : matchType.value,
    read: file ? 'DENY' : null, write: file ? 'DENY' : null, delete: file ? 'DENY' : null,
    action: file ? null : 'ASK', enabled: true, preset: null };
  current.value.rules.unshift(rule); freshRule.value = rule;
  pattern.value = ''; change(); notice.value = copy.value.added;
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
    current.value.rules = response.data; freshRule.value = null; change();
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
    validate(response.data, selected); tables[selected] = response.data; freshRule.value = null;
    dirty[selected] = false; notice.value = copy.value.saved;
  } catch { error.value = copy.value.saveError; }
  finally { busy.value = false; }
}
void load();
</script>
<template>
  <div class="space-y-4 min-w-0 text-lx-primary-soft" data-testid="security-center">
    <!-- 第一层：策略清单。沙箱总开关决定 AI 是否跑在隔离环境里，其余三类各自进第二层编辑。 -->
    <template v-if="view === 'list'">
      <section class="sec-rise">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col">
            <span class="flex items-center gap-1.5 text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">
              {{ copy.sandboxTitle }}
              <button type="button" class="sec-info" :aria-label="copy.scope" :aria-expanded="showScope" @click="showScope = !showScope">
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
              </button>
            </span>
            <span class="mt-0.5 text-[11px] leading-snug text-gray-400 dark:text-zinc-400">{{ copy.sandboxDesc }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span :class="[stateChip, sandboxState === 'ON'
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : sandboxState === 'OFF'
                ? 'border-gray-200 text-lx-muted dark:border-white/15'
                : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400']" data-testid="security-sandbox-state">{{ sandboxStateLabel }}</span>
            <button type="button" role="switch" :aria-checked="sandboxState === 'ON'" :aria-label="copy.sandboxTitle" :disabled="isSavingEnv"
              :class="['sec-switch', sandboxState === 'ON' ? 'is-on' : '']" data-testid="security-sandbox-toggle" @click="setSandboxEnabled(sandboxState !== 'ON')">
              <span class="sec-switch__knob" />
            </button>
          </div>
        </div>

        <!-- 沙箱服务能力检查（随沙箱设置一起从通用页搬来） -->
        <div class="mt-3 flex items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-white/10">
          <span class="flex min-w-0 items-center gap-1.5 text-[11px] leading-5 text-lx-muted">
            <span :class="['h-1.5 w-1.5 shrink-0 rounded-full', sandboxStatus ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-white/20']" aria-hidden="true" />
            <span class="min-w-0">{{ t('settings.general.sandboxService') }}：{{ sandboxStatus?.message || t('settings.general.sandboxServiceDesc') }}</span>
          </span>
          <button type="button" :class="[button, 'shrink-0']" :disabled="isCheckingSandbox" data-testid="security-check-service" @click="checkSandboxService">
            {{ isCheckingSandbox ? t('settings.general.sandboxChecking') : t('settings.general.sandboxCheck') }}
          </button>
        </div>
        <p v-if="isCheckingSandbox" class="mt-2 text-[11px] leading-snug text-gray-400 dark:text-zinc-400">{{ t('settings.general.sandboxCheckingHint') }}</p>
        <div v-if="sandboxNotice" class="sec-rise mt-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-[11px] text-emerald-600 dark:text-emerald-400">{{ sandboxNotice }}</div>
        <div v-if="sandboxError" class="sec-rise mt-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2.5 text-[11px] text-red-600 dark:text-red-400">{{ sandboxError }}</div>
        <div v-if="showScope" class="sec-rise mt-2 rounded-xl border border-gray-100 bg-white/70 p-2.5 dark:border-white/10 dark:bg-white/[0.03]">
          <p class="text-[11px] font-medium text-lx-tertiary">{{ copy.scope }}</p>
          <p class="mt-1 text-[11px] leading-5 text-lx-muted">{{ copy.fileLimits }}</p>
        </div>
      </section>

      <!-- 三个入口行：标题 + 一句说明 + 箭头 -->
      <div class="sec-rise divide-y divide-gray-100 dark:divide-white/10" :style="{ '--sec-delay': '60ms' }">
        <button v-for="item in categories" :key="item" type="button" :data-testid="`security-tab-${item}`" @click="open(item)"
          class="sec-nav flex w-full items-center justify-between gap-3 rounded-xl px-2 py-3 text-left transition-colors cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
          <span class="flex min-w-0 flex-col">
            <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ copy[item] }}</span>
            <span class="mt-0.5 text-[11px] leading-snug text-gray-400 dark:text-zinc-400">{{ copy[categoryDesc[item]] }}</span>
          </span>
          <svg class="sec-nav-chevron h-3.5 w-3.5 shrink-0 text-gray-300 dark:text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </template>

    <!-- 第二层：某一类策略的编辑器 -->
    <template v-else>
      <div class="sec-rise flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <button type="button" :class="[iconButton, 'h-6 w-6']" :aria-label="copy.back" data-testid="security-back" @click="back">
            <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
          </button>
          <h4 class="truncate text-xs font-semibold tracking-wide text-lx-primary-soft dark:text-glow-subtle">{{ copy[category] }}</h4>
        </div>
        <button v-if="category !== 'net' && current" type="button" :class="button" :disabled="busy" @click="reset" data-testid="security-reset">{{ copy.defaults }}</button>
      </div>
      <p class="sec-rise text-[11px] leading-5 text-lx-muted" :style="{ '--sec-delay': '40ms' }">{{ hint }}</p>

      <!-- 该类规则的默认策略（随沙箱设置一起从通用页搬来）：规则未命中时按它执行 -->
      <section v-if="category === 'files'" :class="[panel, 'sec-rise']" :style="{ '--sec-delay': '70ms' }">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div class="flex min-w-0 flex-col">
            <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.accessMode') }}</span>
            <span class="mt-0.5 text-[11px] leading-snug text-gray-400 dark:text-zinc-400">{{ t('settings.general.accessModeDesc') }}</span>
          </div>
          <div class="w-full min-w-0 shrink-0 sm:w-64">
            <SettingsSelect id="security-access-mode" data-testid="security-access-mode" :label="t('settings.general.accessMode')"
              :model-value="accessMode" :options="accessModeOptions" @update:model-value="selectAccessMode" />
          </div>
        </div>
      </section>
      <section v-else-if="category === 'terminal'" :class="[panel, 'sec-rise']" :style="{ '--sec-delay': '70ms' }">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div class="flex min-w-0 flex-col">
            <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.toolPermission') }}</span>
            <span class="mt-0.5 text-[11px] leading-snug text-gray-400 dark:text-zinc-400">{{ t('settings.general.toolPermissionDesc') }}</span>
          </div>
          <div class="w-full min-w-0 shrink-0 sm:w-64">
            <SettingsSelect id="security-command-policy" data-testid="security-command-policy" :label="t('settings.general.toolPermission')"
              :model-value="commandApprovalPolicy" :options="commandApprovalPolicyOptions" @update:model-value="selectCommandPolicy" />
          </div>
        </div>
      </section>

      <div v-if="error" role="alert" :class="['sec-rise flex flex-wrap items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400']" data-testid="security-error">
        <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
        <span class="min-w-0 flex-1 leading-5">{{ error }}</span>
        <button type="button" :class="[button, 'shrink-0 border-red-500/30 text-red-600 hover:bg-red-500/10 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/15']" :disabled="busy" @click="load()">{{ copy.retry }}</button>
      </div>

      <!-- 首屏只铺骨架；已有数据时保留内容不抽空，否则保存失败会把用户的草稿从眼前抹掉 -->
      <div v-if="busy && !current" class="space-y-3">
        <div :class="[panel, 'space-y-2.5']">
          <div class="sec-skeleton h-3 w-24"></div>
          <div class="sec-skeleton h-2.5 w-full"></div>
          <div class="sec-skeleton h-2.5 w-4/5"></div>
        </div>
        <div :class="[panel, 'space-y-3']">
          <div class="sec-skeleton h-8 w-full"></div>
          <div v-for="row in 3" :key="row" class="sec-skeleton h-6 w-full"></div>
        </div>
        <p role="status" class="text-center text-[11px] text-gray-400 dark:text-zinc-500">{{ copy.loading }}</p>
      </div>

      <template v-if="current">
        <p role="status" class="sec-rise flex items-start gap-1.5 text-[11px] leading-5 text-lx-muted">
          <svg class="mt-[3px] h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
          <span class="min-w-0">{{ activeHint }}</span>
        </p>

        <section v-if="category === 'net'" :class="[panel, 'sec-rise']" data-testid="security-net-allow">
          <div class="flex items-center gap-2">
            <span class="relative grid h-2 w-2 shrink-0 place-items-center" aria-hidden="true">
              <span class="sec-ping absolute h-full w-full rounded-full bg-emerald-500/60"></span>
              <span class="relative h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <span class="text-xs font-semibold text-lx-primary-soft dark:text-glow-subtle">{{ copy.netStatus }}</span>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-lx-muted">{{ copy.netDetail }}</p>
        </section>

        <fieldset v-else :disabled="busy" :class="[panel, 'sec-rise min-w-0']">
          <legend class="sr-only">{{ copy.rules }}</legend>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="add">
            <div v-if="category === 'terminal'" class="w-28 shrink-0">
              <SettingsSelect id="security-match-type" data-testid="security-match-type" :label="copy.prefix" :model-value="matchType"
                :options="[{ value: 'PREFIX', label: copy.prefix }, { value: 'PROGRAM', label: copy.program }]"
                @update:model-value="selectMatchType" />
            </div>
            <input v-model="pattern" :class="[control, 'min-w-0 flex-1 w-full']" :placeholder="copy[category === 'files' ? 'filePlaceholder' : 'terminalPlaceholder']" :aria-label="copy.add" data-testid="security-pattern" />
            <button type="submit" :class="[primary, 'flex shrink-0 items-center gap-1']" data-testid="security-add">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 4.5v15m7.5-7.5h-15" /></svg>{{ copy.add }}
            </button>
          </form>

          <div class="mt-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="flex items-center gap-1.5 text-[11px] font-medium text-lx-muted">{{ copy.rules }}
              <span class="rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold tabular-nums dark:bg-white/10">{{ current.rules.length }}</span>
            </span>
            <span class="text-[11px] leading-5 text-gray-400 dark:text-zinc-500">{{ copy.moveHint }}</span>
          </div>

          <!-- 空态：虚线框 + 图标，与 MCP 列表的空态同一语气 -->
          <div v-if="!current.rules.length" class="grid place-items-center gap-2 rounded-2xl border border-dashed border-gray-200 py-10 text-center dark:border-white/15">
            <svg class="h-6 w-6 text-gray-300 dark:text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>
            <p class="text-[11px] text-gray-400 dark:text-zinc-500">{{ copy.empty }}</p>
          </div>

          <div v-for="(rule, index) in current.rules" :key="resolveRuleKey(rule)"
            :class="['sec-rise group mt-2 rounded-xl border border-gray-200/80 bg-white/70 p-2.5 transition-colors hover:border-gray-300 hover:bg-white dark:border-white/10 dark:bg-white/[0.02] dark:hover:border-white/20 dark:hover:bg-white/[0.05]',
              rule.enabled ? '' : 'opacity-55', rule === freshRule ? 'sec-flash' : '']"
            :style="{ '--sec-delay': `${Math.min(index, 10) * 30}ms` }" data-testid="security-rule">
            <div class="flex items-start gap-2 min-w-0">
              <span :class="['shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                rule.preset ? 'border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'border-gray-200 text-lx-muted dark:border-white/15']">{{ rule.preset ? copy.preset : copy.custom }}</span>
              <code class="min-w-0 flex-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 font-mono text-xs leading-5 text-lx-secondary [overflow-wrap:anywhere] dark:bg-white/[0.06]">{{ rule.pattern }}</code>
              <span class="flex shrink-0 items-center gap-1">
                <label class="sec-check" :title="copy.enabled">
                  <input type="checkbox" v-model="rule.enabled" @change="change" class="sec-check__input" :aria-label="copy.enabled" />
                  <svg class="sec-check__tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </label>
                <button type="button" :class="iconButton" :aria-label="copy.up" :disabled="index === 0" @click="move(index, -1)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M4.5 15.75l7.5-7.5 7.5 7.5" /></svg>
                </button>
                <button type="button" :class="iconButton" :aria-label="copy.down" :disabled="index === current.rules.length - 1" @click="move(index, 1)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                </button>
                <button type="button" :class="[iconButton, 'hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500 dark:hover:border-red-500/40 dark:hover:bg-red-500/15 dark:hover:text-red-400']" :aria-label="copy.remove" @click="remove(index)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            </div>
            <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
              <template v-if="category === 'files'">
                <span class="text-[11px] text-lx-muted">{{ copy.access }}</span>
                <div class="w-28 shrink-0">
                  <SettingsSelect :id="`security-rule-access-${index}`" data-testid="security-access" :label="`${rule.pattern} ${copy.access}`" :model-value="rule.read ?? ''"
                    :options="current.supportedActions.map(action => ({ value: action, label: label(action) }))" @update:model-value="setAccess(rule, $event)" />
                </div>
              </template>
              <div v-else class="w-28 shrink-0">
                <SettingsSelect :id="`security-rule-action-${index}`" data-testid="security-action" :label="rule.pattern" :model-value="rule.action ?? ''"
                  :options="current.supportedActions.map(action => ({ value: action, label: label(action) }))" @update:model-value="setAction(rule, $event)" />
              </div>
            </div>
          </div>
        </fieldset>

        <!-- 保存底栏：浮起的玻璃条，滚动时压住下方规则（sticky 不能被带 transform 的祖先包住） -->
        <div v-if="category !== 'net'" class="sec-rise sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200/80 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-white/10 dark:bg-zinc-950/90" :style="{ '--sec-delay': '140ms' }">
          <span role="status" class="flex items-center gap-1.5 text-[11px] text-lx-muted">
            <span v-if="notice" class="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            <span v-else-if="dirty[category]" class="sec-ping h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            {{ notice || (dirty[category] ? copy.dirty : '') }}
          </span>
          <button type="button" :disabled="!dirty[category] || busy" :class="[primary, 'flex shrink-0 items-center gap-1.5']" @click="save" data-testid="security-save">
            <span v-if="busy" class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
            {{ copy.save }}
          </button>
        </div>
      </template>
    </template>
  </div>
</template>
<style scoped>
@reference "../../../style.css";

/* ================= 安全中心动效 =================
   入场统一用 animation-fill-mode: backwards（不是 both）：动画结束立刻回到自然态，
   不留 transform 残影 —— 残留的 transform 会为 sticky 底栏造出新的包含块，粘性直接失效。 */
@keyframes sec-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.sec-rise {
  animation: sec-rise 0.34s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: var(--sec-delay, 0ms);
}

/* 新增规则入列：描边闪一次。与入场动画并列写，避免后一条 animation 简写把前一条的 animation-name 顶掉。 */
@keyframes sec-flash {
  0% { box-shadow: 0 0 0 1px rgba(6, 182, 212, 0.55), 0 0 12px rgba(6, 182, 212, 0.28); }
  100% { box-shadow: 0 0 0 1px rgba(6, 182, 212, 0), 0 0 0 rgba(6, 182, 212, 0); }
}

.sec-rise.sec-flash {
  animation: sec-rise 0.34s cubic-bezier(0.16, 1, 0.3, 1) backwards, sec-flash 0.9s ease-out;
  animation-delay: var(--sec-delay, 0ms), 0ms;
}

/* 入口行的箭头：悬停时向右让一格 */
.sec-nav-chevron {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.22s ease;
}

.sec-nav:hover .sec-nav-chevron {
  transform: translateX(3px);
  @apply text-gray-500 dark:text-zinc-300;
}

/* 标题旁的说明按钮 */
.sec-info {
  @apply grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-gray-400 transition-colors cursor-pointer dark:text-zinc-500;
}

.sec-info:hover { @apply text-lx-secondary; }

/* ================= 总开关 ================= */
.sec-switch {
  @apply relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-gray-200;
  transition: background-color 0.22s ease;
}

.sec-switch:hover { @apply bg-gray-300; }
.sec-switch.is-on { @apply bg-blue-600; }
.sec-switch.is-on:hover { @apply bg-blue-500; }
.sec-switch:disabled { @apply cursor-not-allowed opacity-50; }

.sec-switch__knob {
  @apply absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm;
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

.sec-switch.is-on .sec-switch__knob { transform: translateX(16px); }

.dark .sec-switch { @apply bg-white/15; }
.dark .sec-switch:hover { @apply bg-white/25; }
.dark .sec-switch.is-on { @apply bg-sky-500; }
.dark .sec-switch.is-on:hover { @apply bg-sky-400; }

/* ================= 自绘复选框 =================
   原生勾选框的选中色是平台渲染的，和这套界面格格不入；改成自绘后勾号还能做一次缩放进入。 */
.sec-check {
  @apply relative grid h-3.5 w-3.5 shrink-0 cursor-pointer place-items-center;
}

.sec-check__input {
  @apply h-3.5 w-3.5 cursor-pointer appearance-none rounded-[5px] border border-gray-300 bg-white;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.sec-check__input:hover { @apply border-gray-400; }
.sec-check__input:checked { @apply border-blue-600 bg-blue-600; }
.sec-check__input:focus-visible { @apply outline-none ring-2 ring-blue-500/30; }

.sec-check__tick {
  @apply pointer-events-none absolute h-2.5 w-2.5 text-white opacity-0;
  transform: scale(0.6);
  transition: opacity 0.14s ease, transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);
}

.sec-check__input:checked + .sec-check__tick { opacity: 1; transform: scale(1); }

.dark .sec-check__input { @apply border-white/25 bg-white/5; }
.dark .sec-check__input:hover { @apply border-white/50; }
.dark .sec-check__input:checked { @apply border-sky-500 bg-sky-500; }
.dark .sec-check__input:focus-visible { @apply ring-sky-400/30; }

/* ================= 骨架与状态灯 ================= */
@keyframes sec-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.sec-skeleton {
  border-radius: 0.5rem;
  background-image: linear-gradient(90deg, rgba(0, 0, 0, 0.05) 25%, rgba(0, 0, 0, 0.1) 37%, rgba(0, 0, 0, 0.05) 63%);
  background-size: 400% 100%;
  animation: sec-shimmer 1.4s ease-in-out infinite;
}

.dark .sec-skeleton {
  background-image: linear-gradient(90deg, rgba(255, 255, 255, 0.05) 25%, rgba(255, 255, 255, 0.12) 37%, rgba(255, 255, 255, 0.05) 63%);
}

@keyframes sec-ping {
  75%, 100% { transform: scale(2.4); opacity: 0; }
}

.sec-ping { animation: sec-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite; }

@media (prefers-reduced-motion: reduce) {
  .sec-rise,
  .sec-rise.sec-flash,
  .sec-skeleton,
  .sec-ping {
    animation: none !important;
  }

  .sec-nav-chevron,
  .sec-switch,
  .sec-switch__knob,
  .sec-check__input,
  .sec-check__tick {
    transition: none !important;
  }
}
</style>
