<template>
  <div class="inline-flex" @mouseenter="showDetails" @mouseleave="hideDetails">
    <button ref="trigger" type="button" class="usage-trigger" :class="{ dark: isDark }"
      :aria-label="t('chat.message.roundUsage')" :aria-controls="cardId" :aria-expanded="expanded"
      @focus="showDetails" @blur="hideDetails" @click="showDetails" @keydown.esc="hideDetails">
      <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
      </svg>
      <span>{{ t('chat.message.usageTokens', { tokens: compactTotal }) }}</span>
    </button>
    <div :id="cardId" ref="card" popover="auto" role="tooltip" class="usage-card"
      :class="{ dark: isDark }" :style="position" @toggle="expanded = $event.newState === 'open'">
      <div class="usage-heading">
        <span class="usage-title">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
          </svg>
          {{ t('chat.message.roundUsage') }}
        </span>
        <span>{{ formatCount(total) }}</span>
      </div>
      <dl class="usage-rows">
        <div><dt>{{ t('chat.message.usageModel') }}</dt><dd class="usage-model">{{ modelLabel }}</dd></div>
        <div><dt>{{ t('chat.message.cacheHit') }}</dt><dd>{{ hitRate == null ? t('format.none') : `${(hitRate * 100).toFixed(1)}%` }}</dd></div>
        <div><dt>{{ t('chat.message.uncachedInput') }}</dt><dd>{{ formatCount(uncachedInput) }}</dd></div>
        <div><dt>{{ t('chat.message.cacheRead') }}</dt><dd>{{ formatCount(usage?.cacheTokens) }}</dd></div>
        <div><dt>{{ t('chat.message.usageOutput') }}</dt><dd>{{ formatCount(usage?.outputTokenCount) }}
          <span class="usage-reasoning">{{ t('chat.message.reasoningIncluded', { tokens: formatCount(usage?.reasoningTokens) }) }}</span>
        </dd></div>
      </dl>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import type { TokenInfo } from '../../types/Event';
import { resolveCacheHitRate, resolveTotalTokens, resolveUncachedInputTokens } from '../../utils/tokenUsage';
import { t } from '../../i18n';

const props = defineProps<{ usage: TokenInfo | null; modelName?: string | null; modelProvider?: string | null; isDark: boolean }>();
const trigger = ref<HTMLButtonElement>();
const card = ref<HTMLDivElement>();
const cardId = useId();
const expanded = ref(false);
const position = ref({ left: '0px', top: '0px' });
const total = computed(() => resolveTotalTokens(props.usage));
const hitRate = computed(() => resolveCacheHitRate(props.usage));
const uncachedInput = computed(() => resolveUncachedInputTokens(props.usage));
const modelLabel = computed(() => [props.modelProvider, props.modelName].filter(Boolean).join('/') || t('format.none'));
const formatCount = (count?: number | null): string => count == null ? t('format.none') : `${count.toLocaleString('en-US')} token`;
const compactTotal = computed(() => total.value == null ? t('format.noStats')
  : total.value >= 1000 ? `${Math.round(total.value / 1000)}K token` : `${total.value} token`);

/** 顶层弹层不受聊天滚动容器裁切，位置限制在可视区内。 */
function showDetails() {
  if (!trigger.value || !card.value) return;
  card.value.showPopover();
  const anchor = trigger.value.getBoundingClientRect();
  const bounds = card.value.getBoundingClientRect();
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12));
  const top = anchor.top >= bounds.height + 20 ? anchor.top - bounds.height - 8 : anchor.bottom + 8;
  position.value = { left: `${left}px`, top: `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px` };
}
function hideDetails() { card.value?.hidePopover(); }
onMounted(() => {
  window.addEventListener('scroll', hideDetails, true);
  window.addEventListener('resize', hideDetails);
});
onUnmounted(() => {
  window.removeEventListener('scroll', hideDetails, true);
  window.removeEventListener('resize', hideDetails);
});
</script>

<style scoped>
.usage-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 7px; color: #858b94; background: transparent; cursor: pointer; white-space: nowrap; }
.usage-trigger:hover, .usage-trigger:focus-visible { background: #e8eaed; color: #626975; }
.usage-trigger:focus-visible { outline: 2px solid #94a3b8; outline-offset: 2px; }
.usage-card { position: fixed; inset: auto; margin: 0; width: 320px; max-width: calc(100vw - 24px); padding: 12px 16px 14px; border: 1px solid #e9eaec; border-radius: 14px; background: #f9fafb; color: #626975; box-shadow: 0 2px 8px #0000000a; font-size: 12px; line-height: 1.6; }
.usage-card::backdrop { background: transparent; }
.usage-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid #dcdfe3; color: #20242a; }
.usage-title { display: inline-flex; align-items: center; gap: 5px; }
.usage-rows { display: grid; gap: 5px; margin: 10px 0 0; }
.usage-rows > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.usage-rows dt { flex-shrink: 0; color: #858b94; }
.usage-rows dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.usage-model { font-size: 11px; }
.usage-reasoning { color: #858b94; }
.usage-trigger.dark { background: transparent; color: #a1a1aa; }
.usage-trigger.dark:hover, .usage-trigger.dark:focus-visible { background: #ffffff12; color: #d4d4d8; }
.usage-card.dark { background: #242428; border-color: #ffffff14; color: #d4d4d8; box-shadow: 0 4px 20px #00000040; }
.usage-card.dark .usage-heading { border-color: #ffffff1a; color: #f4f4f5; }
.usage-card.dark dt, .usage-card.dark .usage-reasoning { color: #a1a1aa; }
</style>
