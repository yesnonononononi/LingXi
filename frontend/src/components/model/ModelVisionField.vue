<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from '../../i18n';

defineProps<{ modelValue: boolean; isDark: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();
const { t } = useI18n();
const id = useId();
</script>

<template>
  <div class="rounded-xl border p-3 space-y-2" :class="isDark ? 'border-white/15 bg-white/5' : 'border-zinc-200 bg-zinc-50'">
    <label class="flex items-center gap-2.5 text-xs font-medium text-lx-primary-soft cursor-pointer">
      <input :checked="modelValue" type="checkbox" data-testid="model-vision" :aria-describedby="`${id}-help ${id}-warning`"
        class="h-4 w-4 accent-blue-600 cursor-pointer"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
      {{ t('settings.models.visionLabel') }}
    </label>
    <p :id="`${id}-help`" class="text-xs leading-relaxed" :class="isDark ? 'text-zinc-400' : 'text-zinc-600'">{{ t('settings.models.visionHelp') }}</p>
    <p :id="`${id}-warning`" role="note" class="text-xs leading-relaxed" :class="isDark ? 'text-amber-300' : 'text-amber-800'">{{ t('settings.models.visionWarning') }}</p>
  </div>
</template>
