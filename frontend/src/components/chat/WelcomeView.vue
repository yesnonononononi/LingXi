<script setup lang="ts">
import TextType from '../common/TextType.vue';

withDefaults(
  defineProps<{
    isDark?: boolean;
    text?: string | string[];
  }>(),
  {
    text: '今天想构建什么？'
  }
);

const emit = defineEmits<{
  (e: 'selectPrompt', text: string): void;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center select-none pb-4">
    <!-- Brand Hero Row: Title -->
    <div class="flex items-center justify-center">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center min-h-[36px]">
        <TextType
          as="span"
          :text="text"
          :loop="false"
          :typing-speed="75"
          :pause-duration="1500"
          :show-cursor="true"
          :hide-cursor-on-complete="true"
          cursor-character="|"
          cursor-class-name="text-blue-500 font-normal ml-0.5"
        />
      </h1>
    </div>
  </div>
</template>
