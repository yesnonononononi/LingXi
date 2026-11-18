<script setup lang="ts">
import {computed} from 'vue';
import type {ContextFactCard} from '../../utils/contextFacts';
import {contextSectionLabel} from '../../utils/contextSectionLabel';
import {t} from '../../i18n';

/**
 * 上下文事实提示卡（左上角实时渲染）。
 *
 * <p>只回答「哪几类动态段被改写了 / 上下文被重建了」。卡片会自动消失，长文本塞进去等于
 * 用户永远读不完，所以这里不承载差异明细，也不提供跳转入口。</p>
 */
const props = defineProps<{card: ContextFactCard}>();
const emit = defineEmits<{(e: 'dismiss', id: string): void}>();

const title = computed(() => t(props.card.kind === 'rebuilt' ? 'chat.contextFact.rebuiltTitle' : 'chat.contextFact.changedTitle'));

const body = computed(() => {
  if (props.card.kind === 'rebuilt') {
    if (props.card.summaryGeneration == null && props.card.messageCount == null) {
      return t('chat.contextFact.rebuiltBodyUnknown');
    }
    return t('chat.contextFact.rebuiltBody', {
      generation: props.card.summaryGeneration ?? 0,
      count: props.card.messageCount ?? 0,
    });
  }
  // 系统提示词被重写是唯一「缓存前缀没了」的变化，优先级高于「哪几段改了」
  if (!props.card.prefixPreserved) return t('chat.contextFact.prefixBroken');
  if (props.card.changedKinds.length) {
    return t('chat.contextFact.sectionsChanged', {
      sections: props.card.changedKinds.map(kind => contextSectionLabel(kind)).join('、'),
    });
  }
  return t('chat.contextFact.reasonsOnly');
});

const meta = computed(() => {
  const live = props.card.liveBlocks;
  return live ? t('chat.contextFact.liveBlocks', {current: live.current, max: live.max}) : '';
});
</script>

<template>
  <div
    class="context-fact-card"
    role="status"
    data-test="context-fact-card"
    :data-kind="card.kind"
  >
    <span class="context-fact-card__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="8.5" />
        <line x1="12" y1="10.6" x2="12" y2="16.4" />
        <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    </span>

    <div class="context-fact-card__content">
      <div class="context-fact-card__title-row">
        <span class="context-fact-card__title">{{ title }}</span>
      </div>
      <div class="context-fact-card__body" data-test="context-fact-body">{{ body }}</div>
      <div v-if="meta" class="context-fact-card__meta">{{ meta }}</div>
    </div>

    <button
      type="button"
      class="context-fact-card__close"
      data-test="context-fact-close"
      :aria-label="t('chat.contextFact.close')"
      :title="t('chat.contextFact.close')"
      @click.stop="emit('dismiss', card.id)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
        <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* 颜色与形态一律走主题令牌：深浅两套值由 tokens.css 的 .dark 提供，
   这里不再写第二份深色覆盖 —— 抄一遍颜色就意味着换主题时它会掉队。 */
.context-fact-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 286px;
  box-sizing: border-box;
  padding: 12px 12px 12px 13px;
  border-radius: var(--lx-radius-lg);
  border: 1px solid var(--lx-border-subtle);
  background: var(--lx-surface-elevated);
  box-shadow: var(--lx-shadow-2);
  animation: context-fact-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.context-fact-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: var(--lx-radius-full);
  background: var(--lx-accent);
  color: var(--lx-text-on-accent);
}

.context-fact-card__icon svg {
  width: 14px;
  height: 14px;
}

.context-fact-card__content {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: 14px;
}

.context-fact-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.context-fact-card__title {
  font-size: var(--lx-font-size-sm);
  font-weight: 600;
  color: var(--lx-text-primary);
  white-space: nowrap;
}

.context-fact-card__body {
  font-size: var(--lx-font-size-sm);
  line-height: 1.5;
  color: var(--lx-text-secondary);
  overflow-wrap: anywhere;
}

.context-fact-card__meta {
  font-size: var(--lx-font-size-2xs);
  color: var(--lx-text-faint);
}

.context-fact-card__close {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--lx-radius-sm);
  background: transparent;
  color: var(--lx-text-faint);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}

.context-fact-card__close svg {
  width: 11px;
  height: 11px;
}

.context-fact-card__close:hover {
  background: var(--lx-surface-hover);
  color: var(--lx-text-primary);
}

@keyframes context-fact-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
