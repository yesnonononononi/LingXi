<script setup lang="ts">
import { t } from '../../i18n';
withDefaults(defineProps<{ status?: string; canResume: boolean; resuming: boolean;
  hasUnresolved: boolean; error: string; supplementDraft?: string; supplementOpen?: boolean }>(),
  { supplementDraft: '', supplementOpen: false });
const emit = defineEmits<{ (event: 'resume'): void;
  (event: 'update:supplementDraft', value: string): void;
  (event: 'update:supplementOpen', value: boolean): void }>();
</script>

<template>
  <!-- 运行中不占位：状态由消息区的流式输出自行体现，这里只保留需要用户处置的暂停与错误。 -->
  <div v-if="status === 'SUSPENDED' || error || supplementDraft" class="w-full max-w-lx-chat px-4 mb-2 text-xs">
    <!-- 有待审批/待回答卡片时不出现：此类暂停下 resume 必被 canResume 挡掉（要等卡片答完），
         「请先处理卡片」的提示也由卡片本身承担，留着只是一行禁用按钮占位置。 -->
    <div v-if="status === 'SUSPENDED' && !hasUnresolved" class="flex items-center justify-between gap-3 py-1">
      <span role="status" class="text-lx-muted">
        {{ hasUnresolved ? t('chat.controls.waitingApproval') : t('chat.controls.paused') }}
      </span>
      <div class="flex shrink-0 items-center gap-3">
      <button type="button" :disabled="resuming" data-testid="toggle-resume-supplement"
        :aria-expanded="supplementOpen" class="cursor-pointer text-lx-muted hover:text-lx-primary disabled:opacity-50"
        @click="emit('update:supplementOpen', !supplementOpen)">{{ t('chat.controls.supplementLabel') }}</button>
      <button type="button" :disabled="!canResume" data-testid="resume-generation"
        class="rounded-lg bg-blue-600 text-white px-3 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        @click="emit('resume')">{{ resuming ? t('chat.controls.resuming') : supplementDraft.trim() ? t('chat.controls.supplementResume') : t('chat.controls.resume') }}</button>
      </div>
    </div>
    <button v-if="status !== 'SUSPENDED' && supplementDraft && !supplementOpen" type="button"
      class="cursor-pointer py-1 text-lx-muted" @click="emit('update:supplementOpen', true)">
      {{ t('chat.controls.supplementUnsent') }}
    </button>
    <div v-if="supplementOpen" class="mt-2 space-y-1.5">
      <textarea :value="supplementDraft" :disabled="resuming" rows="3" maxlength="20000"
        data-testid="resume-supplement-input" :aria-label="t('chat.controls.supplementLabel')"
        :placeholder="t('chat.controls.supplementPlaceholder')"
        class="w-full resize-y rounded-xl border border-lx-border bg-lx-surface px-3 py-2 text-sm text-lx-primary outline-none focus:border-blue-500 disabled:opacity-60"
        @input="emit('update:supplementDraft', ($event.target as HTMLTextAreaElement).value)" />
      <p class="text-lx-muted" role="status">{{ status === 'SUSPENDED' ? t('chat.controls.supplementHint') : t('chat.controls.supplementStale') }}</p>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-red-500">{{ error }}</p>
  </div>
</template>
