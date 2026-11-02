<script setup lang="ts">
import {t} from '../../i18n';
import {ref} from 'vue';
import ModelInvocationField from './ModelInvocationField.vue';
import ModelVisionField from './ModelVisionField.vue';

defineProps<{provider: string; vision: boolean; isDark: boolean}>();
const emit = defineEmits<{'update:provider': [value: string]; 'update:vision': [value: boolean]}>();
const expanded = ref(false);
</script>

<template>
  <details class="model-advanced group/model-advanced rounded-xl border"
    :class="isDark ? 'border-white/15' : 'border-zinc-200'" data-testid="model-advanced-options"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
      :class="isDark ? 'hover:bg-white/5' : 'hover:bg-zinc-50'">
      <span class="font-medium text-lx-primary-soft">{{ t('settings.models.advancedOptions') }}</span>
      <span class="ml-auto text-lx-muted">{{ provider === 'default-image-model' ? t('settings.models.invocationImage') : t('settings.models.invocationChat') }}</span>
      <svg class="h-3.5 w-3.5 shrink-0 text-lx-muted transition-transform group-open/model-advanced:rotate-180"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </summary>
    <div class="space-y-4 border-t p-3" :class="isDark ? 'border-white/10' : 'border-zinc-100'">
      <ModelInvocationField :model-value="provider" :is-dark="isDark" :disabled="!expanded" @update:model-value="emit('update:provider', $event)" />
      <ModelVisionField :model-value="vision" :is-dark="isDark" @update:model-value="emit('update:vision', $event)" />
    </div>
  </details>
</template>

<style scoped>
.model-advanced > summary::-webkit-details-marker { display: none; }
</style>
