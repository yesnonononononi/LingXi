<script setup lang="ts">
import {computed, useId} from 'vue';
import {t} from '../../i18n';
import SettingsSelect from '../common/SettingsSelect.vue';
const props = defineProps<{modelValue: string; isDark: boolean; disabled?: boolean}>();
const emit = defineEmits<{'update:modelValue': [value: string]}>();
const id = useId();
const options = computed(() => [
  {value: props.modelValue === 'default-image-model' ? '' : props.modelValue,
    label: t('settings.models.invocationChat'), desc: t('settings.models.invocationChatDesc')},
  {value: 'default-image-model', label: t('settings.models.invocationImage'), desc: t('settings.models.invocationImageDesc')},
]);
</script>

<template>
  <div class="space-y-2">
    <label :for="id" class="block text-xs font-medium text-lx-primary-soft">{{ t('settings.models.invocationLabel') }}</label>
    <SettingsSelect :id="id" :label="t('settings.models.invocationLabel')" :model-value="modelValue"
      :options="options" :disabled="disabled" data-testid="model-invocation" @update:model-value="emit('update:modelValue', $event)" />
    <p v-if="modelValue === 'default-image-model'" class="text-xs leading-relaxed text-lx-muted">{{ t('settings.models.invocationHelp') }}</p>
  </div>
</template>
