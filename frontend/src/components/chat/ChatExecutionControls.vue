<script setup lang="ts">
import { t } from '../../i18n';
defineProps<{ status?: string; canResume: boolean; resuming: boolean;
  hasUnresolved: boolean; error: string }>();
const emit = defineEmits<{ (event: 'resume'): void }>();
</script>

<template>
  <!-- 运行中不占位：状态由消息区的流式输出自行体现，这里只保留需要用户处置的暂停与错误。 -->
  <div v-if="status === 'SUSPENDED' || error" class="w-full max-w-3xl px-4 mb-2 text-xs">
    <!-- 有待审批/待回答卡片时不出现：此类暂停下 resume 必被 canResume 挡掉（要等卡片答完），
         「请先处理卡片」的提示也由卡片本身承担，留着只是一行禁用按钮占位置。 -->
    <div v-if="status === 'SUSPENDED' && !hasUnresolved" class="flex items-center justify-between gap-3 py-1">
      <span role="status" class="text-gray-500 dark:text-zinc-400">
        {{ hasUnresolved ? t('chat.controls.waitingApproval') : t('chat.controls.paused') }}
      </span>
      <button type="button" :disabled="!canResume" data-testid="resume-generation"
        class="rounded-lg bg-blue-600 text-white px-3 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        @click="emit('resume')">{{ resuming ? t('chat.controls.resuming') : t('chat.controls.resume') }}</button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-red-500">{{ error }}</p>
  </div>
</template>
