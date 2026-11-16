<script setup lang="ts">
/** 内置浏览器「Show with Agent」弹窗：展示视口截图与选中文本，支持按需勾选截图/HTML 并校验长度后发往 Agent。 */
import {computed, nextTick, ref, watch} from 'vue';
import {t} from '../../i18n';
import LxModal from '../common/LxModal.vue';
import type {ShowWithAgentPayload} from '../../types/projectPagePreview';
import {
  MAX_CHAT_INPUT_CHARS,
  MAX_SHOW_WITH_AGENT_HTML_CHARS,
  sanitizePageHtml,
  validateShowWithAgentHtml,
} from '../../utils/htmlSanitizer';
import {composeMessageWithDocuments, createPastedDocument, type PastedDocument} from '../../utils/pastedDocument';

export interface ShowWithAgentSubmitData {
  text: string;
  files: File[];
  htmlDocument: PastedDocument | null;
}

const props = defineProps<{
  open: boolean;
  payload: ShowWithAgentPayload | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'send', data: ShowWithAgentSubmitData): void;
  (e: 'insert', data: ShowWithAgentSubmitData): void;
}>();

const requirement = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const imageSrc = ref('');
const includeImage = ref(true);
const includeHtml = ref(false);
const validationError = ref('');

const cleanedHtml = computed(() => sanitizePageHtml(props.payload?.html ?? ''));
const hasHtml = computed(() => cleanedHtml.value.length > 0);
const htmlValidation = computed(() => validateShowWithAgentHtml(cleanedHtml.value));
const htmlTooltip = computed(() =>
  t('projectPagePreview.showWithAgentHtmlHint', { limit: MAX_SHOW_WITH_AGENT_HTML_CHARS }),
);

watch(() => [props.open, props.payload], () => {
  if (props.open && props.payload) {
    requirement.value = '';
    validationError.value = '';
    includeImage.value = true;
    includeHtml.value = cleanedHtml.value.length > 0;
    if (imageSrc.value) {
      URL.revokeObjectURL(imageSrc.value);
      imageSrc.value = '';
    }
    const blob = new Blob([props.payload.imageBuffer], { type: 'image/png' });
    imageSrc.value = URL.createObjectURL(blob);
    void nextTick(() => {
      textareaRef.value?.focus();
    });
  } else {
    if (imageSrc.value) {
      URL.revokeObjectURL(imageSrc.value);
      imageSrc.value = '';
    }
  }
}, { immediate: true });

watch([includeImage, includeHtml, requirement], () => {
  if (validationError.value) validationError.value = '';
});

const pageTitle = computed(() => {
  if (!props.payload) return '';
  return props.payload.title?.trim() || props.payload.url || '';
});

const buildPrompt = (): string => {
  if (!props.payload) return requirement.value.trim();
  const title = pageTitle.value;
  const url = props.payload.url;
  const text = requirement.value.trim();
  const selection = props.payload.selectionText?.trim();

  if (selection) {
    return text
      ? `针对页面【${title}】(${url}) 中选中的内容：\n> ${selection}\n\n需求：${text}`
      : `针对页面【${title}】(${url}) 中选中的内容：\n> ${selection}\n\n请结合页面上下文进行分析并提出修改建议。`;
  }
  return text
    ? `针对页面【${title}】(${url})，需求如下：\n${text}`
    : `针对页面【${title}】(${url})，请分析当前页面并提出优化与修改建议。`;
};

const createImageFile = (): File | null => {
  if (!props.payload) return null;
  const blob = new Blob([props.payload.imageBuffer], { type: 'image/png' });
  return new File([blob], `page-preview-${Date.now()}.png`, { type: 'image/png' });
};

const resolveHtmlDocTitle = (): string => {
  const title = pageTitle.value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40).trim();
  return title ? `${title}.html` : 'page.html';
};

const buildSubmitData = (): ShowWithAgentSubmitData | null => {
  if (!props.payload) return null;

  if (!includeImage.value && !includeHtml.value && !requirement.value.trim()) {
    validationError.value = t('projectPagePreview.showWithAgentEmptyContent');
    return null;
  }

  if (includeHtml.value && !htmlValidation.value.valid) {
    validationError.value = t('projectPagePreview.showWithAgentHtmlTooLong', {
      count: htmlValidation.value.charCount,
      limit: htmlValidation.value.limit,
    });
    return null;
  }

  const files: File[] = [];
  if (includeImage.value) {
    const file = createImageFile();
    if (file) files.push(file);
  }

  const htmlDocument = includeHtml.value && cleanedHtml.value
    ? createPastedDocument(cleanedHtml.value, { title: resolveHtmlDocTitle() })
    : null;

  const text = buildPrompt();
  if (htmlDocument) {
    const composed = composeMessageWithDocuments(text, [htmlDocument]);
    if (composed.length > MAX_CHAT_INPUT_CHARS) {
      validationError.value = t('projectPagePreview.showWithAgentHtmlTooLong', {
        count: composed.length,
        limit: MAX_CHAT_INPUT_CHARS,
      });
      return null;
    }
  }

  return { text, files, htmlDocument };
};

const handleSend = () => {
  const data = buildSubmitData();
  if (!data) return;
  emit('send', data);
};

const handleInsert = () => {
  const data = buildSubmitData();
  if (!data) return;
  emit('insert', data);
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    handleSend();
  }
};
</script>

<template>
  <LxModal
    :open="open"
    :closeOnBackdrop="true"
    :closeOnEsc="true"
    overlayClass="bg-black/50 backdrop-blur-xs z-50 transition-opacity duration-200"
    panelClass="w-full max-w-lg bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-5 text-zinc-900 dark:text-zinc-100 flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
    :ariaLabel="t('projectPagePreview.showWithAgentModalTitle')"
    @close="emit('close')"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold truncate">{{ t('projectPagePreview.showWithAgentModalTitle') }}</h3>
          <p class="text-xs text-zinc-500 dark:text-zinc-400 truncate">{{ pageTitle }}</p>
        </div>
      </div>
      <button
        type="button"
        class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1 rounded-md transition-colors"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="flex items-start gap-3 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/70 dark:border-zinc-800/70">
      <div v-if="imageSrc" class="w-24 h-16 rounded-lg overflow-hidden shrink-0 border border-zinc-200 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800">
        <img :src="imageSrc" alt="页面截图" class="w-full h-full object-cover" />
      </div>
      <div class="min-w-0 flex-1 text-xs space-y-1">
        <div class="font-medium text-zinc-800 dark:text-zinc-200 truncate">{{ pageTitle }}</div>
        <div class="text-zinc-400 dark:text-zinc-500 truncate font-mono text-[11px]">{{ payload?.url }}</div>
        <div v-if="payload?.selectionText" class="mt-1 px-2 py-1 rounded bg-zinc-200/70 dark:bg-zinc-800 border-l-2 text-zinc-700 dark:text-zinc-300 text-[11px] line-clamp-2">
          {{ payload.selectionText }}
        </div>
      </div>
    </div>

    <div class="space-y-1.5">
      <div class="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {{ t('projectPagePreview.showWithAgentAttachmentsLabel') }}
      </div>
      <div class="flex flex-wrap items-center gap-4 text-xs">
        <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input v-model="includeImage" type="checkbox" class="cursor-pointer" />
          <span>{{ t('projectPagePreview.showWithAgentIncludeImage') }}</span>
        </label>

        <div class="inline-flex items-center gap-1.5">
          <label class="inline-flex items-center gap-1.5 select-none" :class="hasHtml ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'">
            <input v-model="includeHtml" type="checkbox" :disabled="!hasHtml" class="cursor-pointer disabled:cursor-not-allowed" />
            <span>{{ t('projectPagePreview.showWithAgentIncludeHtml') }}</span>
            <span v-if="hasHtml" class="text-[11px] text-zinc-400 dark:text-zinc-500">
              ({{ htmlValidation.charCount.toLocaleString() }} / {{ htmlValidation.limit.toLocaleString() }})
            </span>
          </label>
          <span
            class="relative group inline-flex items-center justify-center w-4 h-4 rounded-full text-[11px] font-bold border border-amber-500/60 text-amber-600 dark:text-amber-400 cursor-help select-none"
            :title="htmlTooltip"
            :aria-label="htmlTooltip"
          >
            !
            <span
              class="pointer-events-none hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 w-56 p-2 rounded-lg text-[11px] font-normal leading-snug text-white bg-zinc-900 dark:bg-zinc-800 shadow-lg z-20"
            >
              {{ htmlTooltip }}
            </span>
          </span>
        </div>
      </div>

      <p
        v-if="includeHtml && !htmlValidation.valid"
        class="text-[11px] text-red-500 dark:text-red-400"
      >
        {{ t('projectPagePreview.showWithAgentHtmlTooLong', { count: htmlValidation.charCount, limit: htmlValidation.limit }) }}
      </p>
      <p
        v-else-if="validationError"
        class="text-[11px] text-red-500 dark:text-red-400"
      >
        {{ validationError }}
      </p>
    </div>

    <div class="space-y-1.5">
      <label for="show-with-agent-requirement" class="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {{ t('projectPagePreview.showWithAgentRequirementLabel') }}
      </label>
      <textarea
        id="show-with-agent-requirement"
        ref="textareaRef"
        v-model="requirement"
        class="w-full h-24 p-2.5 text-xs rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 focus:outline-none resize-none placeholder-zinc-400 dark:placeholder-zinc-500 text-zinc-900 dark:text-zinc-100"
        :placeholder="t('projectPagePreview.showWithAgentPromptPlaceholder')"
        @keydown="handleKeydown"
      ></textarea>
      <div class="text-[11px] text-zinc-400 dark:text-zinc-500 text-right">
        {{ t('projectPagePreview.showWithAgentShortcutHint') }}
      </div>
    </div>

    <div class="flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
      <button
        type="button"
        class="px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-transparent transition-colors"
        @click="handleInsert"
      >
        {{ t('projectPagePreview.showWithAgentInsert') }}
      </button>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 transition-colors"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="px-4 py-1.5 text-xs font-medium rounded-lg text-white bg-blue-500 cursor-pointer hover:bg-blue-600 shadow-sm transition-colors"
          @click="handleSend"
        >
          {{ t('projectPagePreview.showWithAgentSend') }}
        </button>
      </div>
    </div>
  </LxModal>
</template>
