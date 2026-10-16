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
/* 初值就是 true：首帧直接铺骨架，否则 onMounted 之前会先闪一帧空卡片再切到骨架 */
const busy = ref(true);
const error = ref('');
const notice = ref('');
const pattern = ref('');
const matchType = ref<'PROGRAM' | 'PREFIX'>('PREFIX');
const current = computed(() => tables[category.value]);
const categories: SecurityCategory[] = ['files', 'terminal', 'net'];
const hint = computed(() => copy.value[category.value === 'files' ? 'fileHint' : category.value === 'terminal' ? 'terminalHint' : 'netHint']);
const activeHint = computed(() => copy.value[category.value === 'files' ? 'fileActive' : category.value === 'terminal' ? 'terminalActive' : 'mcpScope']);

/* 刚添加的规则：入列时闪一次高亮。用对象本身标记，规则不入库任何前端私有字段；
   切换分类时清空，否则整列表重挂会让旧标记的某一行又闪一次。 */
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
const control = 'rounded-xl border border-gray-200 dark:border-white/15 bg-white dark:bg-black/30 text-gray-700 dark:text-zinc-200 px-3 py-1.5 text-xs outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-200/60 dark:focus:border-white/40 dark:focus:ring-white/10';
const button = 'rounded-xl border border-gray-200 dark:border-white/15 px-3 py-1.5 text-xs font-medium transition cursor-pointer hover:bg-black/5 active:scale-[0.97] dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100';
const primary = 'rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition cursor-pointer hover:bg-blue-500 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100';
const iconButton = 'grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-500 transition cursor-pointer dark:border-white/15 dark:text-zinc-400 hover:border-gray-300 hover:bg-black/5 hover:text-gray-900 dark:hover:border-white/25 dark:hover:bg-white/10 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent';
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
  category.value = selected; pattern.value = ''; error.value = ''; notice.value = ''; freshRule.value = null;
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
onMounted(() => load());
</script>
<template>
  <div class="space-y-4 min-w-0 text-gray-800 dark:text-zinc-100" data-testid="security-center">
    <!-- 分类切换：分段控件。选中项抬白并加边框，暗色下带一层微光文字 -->
    <nav class="flex flex-wrap gap-1 rounded-xl border border-gray-100 bg-gray-100/70 p-1 dark:border-white/10 dark:bg-white/[0.05]" :aria-label="copy.page">
      <button v-for="item in categories" :key="item" type="button" :data-testid="`security-tab-${item}`" :disabled="busy" :aria-pressed="category === item" @click="select(item)"
        :class="['flex flex-1 min-w-fit items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
          category === item
            ? 'border-gray-200/70 bg-white text-gray-900 shadow-sm dark:border-white/10 dark:bg-zinc-800 dark:text-white dark:text-glow-subtle'
            : 'border-transparent text-gray-500 hover:bg-white/60 hover:text-gray-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white']">
        <svg v-if="item === 'files'" class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        <svg v-else-if="item === 'terminal'" class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6.75 7.5l3.75 3-3.75 3M12.75 12.75h4.5" />
        </svg>
        <svg v-else class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
        </svg>
        <span>{{ copy[item] }}</span>
      </button>
    </nav>

    <!-- key 跟分类走：切页即重挂，让入场动画整套重放，不必额外维护过渡状态。
         注意这里刻意不加 transform / 过渡：残留 transform 会让 sticky 底栏失去粘性。 -->
    <div :key="category" class="space-y-4 min-w-0">
      <section :class="[panel, 'sec-rise']">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">
            <span class="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-sky-400" aria-hidden="true" />{{ copy[category] }}
          </h4>
          <button v-if="category !== 'net' && current" type="button" :class="button" :disabled="busy" @click="reset" data-testid="security-reset">{{ copy.defaults }}</button>
        </div>
        <p class="mt-2 text-[11px] leading-5 text-gray-500 dark:text-zinc-400">{{ hint }}</p>
        <details v-if="category === 'files'" class="sec-scope mt-2 text-[11px] leading-5 text-gray-500 dark:text-zinc-400">
          <summary class="inline-flex cursor-pointer items-center gap-1 text-gray-500 transition-colors select-none hover:text-gray-900 dark:text-zinc-400 dark:hover:text-white">{{ copy.scope }}
            <svg class="sec-chevron h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
          </summary>
          <p class="mt-2">{{ copy.fileLimits }}</p>
        </details>
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
        <p role="status" class="sec-rise flex items-start gap-1.5 text-[11px] leading-5 text-gray-500 dark:text-zinc-400">
          <svg class="mt-[3px] h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
          <span class="min-w-0">{{ activeHint }}</span>
        </p>

        <section v-if="category === 'net'" :class="[panel, 'sec-rise']" data-testid="security-net-allow">
          <div class="flex items-center gap-2">
            <span class="relative grid h-2 w-2 shrink-0 place-items-center" aria-hidden="true">
              <span class="sec-ping absolute h-full w-full rounded-full bg-emerald-500/60"></span>
              <span class="relative h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <span class="text-xs font-semibold text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">{{ copy.netStatus }}</span>
          </div>
          <p class="mt-2 text-[11px] leading-5 text-gray-500 dark:text-zinc-400">{{ copy.netDetail }}</p>
        </section>

        <fieldset v-else :disabled="busy" :class="[panel, 'sec-rise min-w-0']">
          <legend class="sr-only">{{ copy.rules }}</legend>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="add">
            <select v-if="category === 'terminal'" v-model="matchType" :class="[control, 'cursor-pointer']" :aria-label="copy.prefix"><option value="PREFIX">{{ copy.prefix }}</option><option value="PROGRAM">{{ copy.program }}</option></select>
            <input v-model="pattern" :class="[control, 'min-w-0 flex-1 w-full']" :placeholder="copy[category === 'files' ? 'filePlaceholder' : 'terminalPlaceholder']" :aria-label="copy.add" data-testid="security-pattern" />
            <button type="submit" :class="[primary, 'flex shrink-0 items-center gap-1']" data-testid="security-add">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 4.5v15m7.5-7.5h-15" /></svg>{{ copy.add }}
            </button>
          </form>

          <div class="mt-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="flex items-center gap-1.5 text-[11px] font-medium text-gray-500 dark:text-zinc-400">{{ copy.rules }}
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
                rule.preset ? 'border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'border-gray-200 text-gray-500 dark:border-white/15 dark:text-zinc-400']">{{ rule.preset ? copy.preset : copy.custom }}</span>
              <code class="min-w-0 flex-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 font-mono text-xs leading-5 text-gray-700 [overflow-wrap:anywhere] dark:bg-white/[0.06] dark:text-zinc-200">{{ rule.pattern }}</code>
              <span class="flex shrink-0 items-center gap-1">
                <input type="checkbox" v-model="rule.enabled" @change="change" class="h-3.5 w-3.5 cursor-pointer accent-cyan-500" :aria-label="copy.enabled" />
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
            <div class="mt-2 flex justify-end flex-wrap gap-2">
              <label v-if="category === 'files'" class="flex items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-400">{{ copy.access }}
                <select v-model="rule.read" @change="changeFile(rule)" :class="[control, 'cursor-pointer py-1']" :aria-label="`${rule.pattern} ${copy.access}`"><option v-for="action in current.supportedActions" :key="action" :value="action">{{ label(action) }}</option></select>
              </label>
              <select v-else v-model="rule.action" @change="change" :class="[control, 'cursor-pointer py-1']" :aria-label="rule.pattern"><option v-for="action in current.supportedActions" :key="action" :value="action">{{ label(action) }}</option></select>
            </div>
          </div>
        </fieldset>

        <!-- 保存底栏：浮起的玻璃条，滚动时压住下方规则（sticky 不能被带 transform 的祖先包住） -->
        <div v-if="category !== 'net'" class="sec-rise sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200/80 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-white/10 dark:bg-zinc-950/90" :style="{ '--sec-delay': '140ms' }">
          <span role="status" class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-zinc-400">
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
    </div>
  </div>
</template>
<style scoped>
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

/* <details> 自绘箭头：去掉系统三角，展开时箭头顺指针方向转 90° */
.sec-scope > summary { list-style: none; }
.sec-scope > summary::-webkit-details-marker { display: none; }
.sec-scope .sec-chevron { transition: transform 0.26s cubic-bezier(0.16, 1, 0.3, 1); }
.sec-scope[open] .sec-chevron { transform: rotate(90deg); }
.sec-scope[open] > p { animation: sec-fade-in 0.24s ease-out; }

@keyframes sec-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 首屏骨架的流光 */
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

/* 状态灯外扩脉冲（自带实现，便于在减弱动效里统一关掉） */
@keyframes sec-ping {
  75%, 100% { transform: scale(2.4); opacity: 0; }
}

.sec-ping { animation: sec-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite; }

@media (prefers-reduced-motion: reduce) {
  .sec-rise,
  .sec-rise.sec-flash,
  .sec-skeleton,
  .sec-ping,
  .sec-scope[open] > p {
    animation: none !important;
  }

  .sec-scope .sec-chevron {
    transition: none !important;
  }
}
</style>
