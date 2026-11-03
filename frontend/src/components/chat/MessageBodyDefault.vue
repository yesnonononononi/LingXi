<script setup lang="ts">
/** 正文文本和结构化图片共用一个入口，历史与实时不重复实现。 */
import MarkdownRenderer from './MarkdownRenderer.vue';
import MessageImage from './MessageImage.vue';
import {resolveApiUrl} from '../../utils/apiConfig';
import {t} from '../../i18n';
import type {ChatMessageBodySlotProps} from '../../types/chatMessageSlots';

const props = defineProps<ChatMessageBodySlotProps>();
</script>

<template>
  <MarkdownRenderer
    v-if="props.message.content || !props.message.responseImageUrls?.length"
    :content="props.message.content"
    :is-dark="props.isDark"
    :is-thinking="props.isThinking"
  />
  <div v-if="props.message.responseImageUrls?.length" class="flex flex-wrap gap-3" data-testid="response-images">
    <MessageImage v-for="(url, index) in props.message.responseImageUrls" :key="url"
      :src="url.startsWith('/') ? resolveApiUrl(url) : url"
      :alt="t('chat.message.generatedImageIndex', {index: index + 1})" :is-dark="props.isDark" />
  </div>
</template>
