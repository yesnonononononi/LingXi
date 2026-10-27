<script setup lang="ts">
import { t } from '../../i18n';
import { nextTick, ref, watch } from 'vue';
const props = defineProps<{ open: boolean; modelValue: string; busy: boolean; error: string; imageCount: number }>();
const textarea = ref<HTMLTextAreaElement | null>(null);
watch(() => props.open, async open => { if (open) { await nextTick(); textarea.value?.focus(); } });
const emit = defineEmits<{ (event: 'update:modelValue', text: string): void; (event: 'cancel'): void; (event: 'submit'): void }>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[99990] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
      @click.self="!busy && emit('cancel')" @keydown.esc.stop="!busy && emit('cancel')">
      <section role="dialog" aria-modal="true" :aria-label="t('chat.controls.editResend')"
        class="w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-100">{{ t('chat.controls.editResend') }}</h2>
        <p class="mt-2 text-sm text-lx-muted">{{ t('chat.controls.resendWarning') }}</p>
        <p v-if="imageCount" class="mt-2 text-xs text-zinc-500">{{ t('chat.controls.keepImages', { count: imageCount }) }}</p>
        <textarea ref="textarea" :value="modelValue" :disabled="busy" :aria-label="t('chat.controls.editedPrompt')" rows="7"
          class="mt-4 w-full resize-y rounded-xl border border-zinc-300 dark:border-white/15 bg-transparent p-3 text-sm text-zinc-900 dark:text-zinc-100 select-text"
          @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
        <p v-if="error" role="alert" class="mt-2 text-sm text-red-500">{{ error }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" :disabled="busy" class="rounded-lg border border-zinc-300 dark:border-white/20 px-4 py-2 text-sm text-lx-secondary cursor-pointer disabled:opacity-50"
            @click="emit('cancel')">{{ t('common.cancel') }}</button>
          <button type="button" :disabled="busy || !modelValue.trim()" data-testid="confirm-resend"
            class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white cursor-pointer disabled:opacity-50"
            @click="emit('submit')">{{ busy ? t('chat.controls.resending') : t('chat.controls.confirmResend') }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
