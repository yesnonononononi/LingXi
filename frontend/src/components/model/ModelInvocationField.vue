<script setup lang="ts">
import {useId} from 'vue';
import {t} from '../../i18n';
defineProps<{modelValue: string; isDark: boolean}>();
const emit = defineEmits<{'update:modelValue': [value: string]}>();
const id = useId();
</script>

<template>
  <div class="space-y-2">
    <label :for="id" class="block text-xs font-medium text-lx-primary-soft">{{ t('settings.models.invocationLabel') }}</label>
    <select :id="id" :value="modelValue" data-testid="model-invocation" class="w-full rounded-xl border px-3 py-2 text-sm"
      :class="isDark ? 'border-white/15 bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-800'"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option value="">{{ t('settings.models.invocationChat') }}</option>
      <option v-if="modelValue && modelValue !== 'default-image-model'" :value="modelValue">{{ t('settings.models.invocationChat') }} ({{ modelValue }})</option>
      <option value="default-image-model">{{ t('settings.models.invocationImage') }}</option>
    </select>
    <p class="text-xs leading-relaxed text-lx-muted">{{ t('settings.models.invocationHelp') }}</p>
  </div>
</template>
