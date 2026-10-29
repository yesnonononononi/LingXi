<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import LxModal from '../common/LxModal.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{
  open: boolean;
  title: string;
  content: string;
  isDark?: boolean;
}>();
const emit = defineEmits<{ (event: 'close'): void }>();
const { t } = useI18n();
const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

watch(() => props.open, async open => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    closeButton.value?.focus();
  } else {
    previousFocus?.focus();
  }
});

const containFocus = (event: KeyboardEvent) => {
  const panel = closeButton.value?.closest('[role="dialog"]');
  const controls = panel?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]');
  if (!controls?.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};
</script>

<template>
  <LxModal
    :open="open"
    :aria-label="t('chat.plan.previewTitle')"
    overlay-class="z-[100] bg-black/50"
    :panel-class="['flex h-[90dvh] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-2xl border shadow-xl', isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'].join(' ')"
    @close="emit('close')"
  >
    <div class="flex min-h-0 flex-1 flex-col" @keydown.tab="containFocus">
      <header class="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-700">
        <div class="min-w-0">
          <p class="mb-1 text-xs" :class="isDark ? 'text-zinc-400' : 'text-zinc-500'">{{ t('chat.plan.previewTitle') }}</p>
          <h2 class="break-words text-base font-semibold">{{ title }}</h2>
        </div>
        <button ref="closeButton" type="button" data-testid="plan-preview-close" :aria-label="t('common.close')" class="shrink-0 rounded-lg p-2 hover:bg-zinc-500/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50" :class="isDark ? 'text-zinc-400 hover:text-zinc-100' : 'text-zinc-600 hover:text-zinc-900'" @click="emit('close')">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-width="1.5" d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>
      <div data-testid="plan-preview-content" class="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-5 sm:px-8 text-sm leading-relaxed" tabindex="0">
        <MarkdownRenderer :content="content" :is-dark="isDark" />
      </div>
    </div>
  </LxModal>
</template>
