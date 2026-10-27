<script setup lang="ts">
import TextType from '../common/TextType.vue';
import { t } from '../../i18n';
import { useGreeting } from '../../composables/useGreeting';

withDefaults(
  defineProps<{
    isDark?: boolean;
    /** 外部显式指定文案时优先，否则按时段取问候语。 */
    text?: string | string[];
  }>(),
  {
    text: ''
  }
);

const emit = defineEmits<{
  (e: 'selectPrompt', text: string): void;
}>();

const { text: greetingText, ready: greetingReady } = useGreeting();
</script>

<template>
  <div class="flex flex-col items-center justify-center select-none pb-4">
    <!-- Brand Hero Row: Title -->
    <div class="flex items-center justify-center">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-zinc-100 flex items-center min-h-[36px]">
        <!-- 称呼还没取回来时不渲染打字机，避免默认句与问候句各打一次 -->
        <TextType
          v-if="greetingReady"
          as="span"
          :text="text || greetingText || t('chat.welcome.title')"
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
