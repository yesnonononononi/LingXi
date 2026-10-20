<script setup lang="ts">
import { computed } from 'vue';
import { isBuiltInProviderIcon, isImageProviderIcon } from '../../utils/providerIcons';

const props = withDefaults(defineProps<{
  /** 内置 key / emoji / 图片 URL */
  icon?: string | null;
  /** 提供商名称，用于首字兜底 */
  name?: string | null;
  /** 像素尺寸 */
  size?: number;
}>(), {
  icon: null,
  name: null,
  size: 16,
});

const trimmed = computed(() => (props.icon ?? '').trim());
const builtInKey = computed(() => (isBuiltInProviderIcon(trimmed.value) ? trimmed.value.toLowerCase() : ''));
const isImage = computed(() => isImageProviderIcon(trimmed.value));
/** 非内置、非 URL 的短文本按 emoji 渲染 */
const textIcon = computed(() => (builtInKey.value || isImage.value ? '' : trimmed.value));
const fallbackLetter = computed(() => {
  const name = (props.name ?? '').trim();
  return name ? Array.from(name)[0].toUpperCase() : '?';
});
const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <img
    v-if="isImage"
    :src="trimmed"
    :alt="name ?? ''"
    :style="boxStyle"
    class="rounded-[22%] object-cover shrink-0 select-none"
    draggable="false"
  />
  <span
    v-else-if="textIcon"
    :style="{ fontSize: `${Math.round(size * 0.95)}px`, lineHeight: 1 }"
    class="inline-flex items-center justify-center shrink-0 select-none"
  >{{ textIcon }}</span>
  <svg
    v-else-if="builtInKey"
    :style="boxStyle"
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    class="shrink-0 select-none"
  >
    <template v-if="builtInKey === 'deepseek'">
      <rect width="20" height="20" rx="5" fill="#4D6BFE" />
      <path d="M4.8 12.6c2.4 0 3.5-1.6 4.3-3.7.5-1.2 1-1.9 2-1.9 1.7 0 2.4 1.5 2.4 3.3"
        stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="6.1" cy="8" r="1" fill="#ffffff" />
    </template>
    <template v-else-if="builtInKey === 'anthropic'">
      <circle cx="10" cy="10" r="10" fill="#D97757" />
      <path d="M10 4.2v11.6M5.1 7.1l9.8 5.8M14.9 7.1L5.1 12.9"
        stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" />
    </template>
    <template v-else-if="builtInKey === 'openai'">
      <circle cx="10" cy="10" r="10" fill="#10A37F" />
      <g stroke="#ffffff" stroke-width="1.3" fill="none">
        <ellipse cx="10" cy="10" rx="2.6" ry="6" />
        <ellipse cx="10" cy="10" rx="2.6" ry="6" transform="rotate(60 10 10)" />
        <ellipse cx="10" cy="10" rx="2.6" ry="6" transform="rotate(120 10 10)" />
      </g>
    </template>
    <template v-else-if="builtInKey === 'google'">
      <circle cx="10" cy="10" r="10" fill="#ffffff" />
      <g stroke-width="3" fill="none" stroke-linecap="butt">
        <path d="M10 3.2a6.8 6.8 0 016.6 5.1" stroke="#EA4335" />
        <path d="M16.7 9.4a6.8 6.8 0 01-4.4 6.9" stroke="#FBBC05" />
        <path d="M9.6 16.8a6.8 6.8 0 01-6.1-7.6" stroke="#34A853" />
        <path d="M3.7 7.7A6.8 6.8 0 0110 3.2" stroke="#4285F4" />
      </g>
    </template>
    <template v-else-if="builtInKey === 'meta'">
      <circle cx="10" cy="10" r="10" fill="#0866FF" />
      <path d="M4.2 11.7c0-2.3 1-4.1 2.8-4.1 2.6 0 3.4 4.7 5.7 4.7 1.3 0 2.2-1.1 2.2-2.7s-.9-2.7-2.2-2.7c-2.3 0-3.5 4.7-5.7 4.7-1.1 0-1.7-.8-1.7-1.9"
        stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" />
    </template>
    <template v-else-if="builtInKey === 'qwen'">
      <rect width="20" height="20" rx="5" fill="#615CED" />
      <path d="M10 5.1l4.9 4.9-4.9 4.9L5.1 10z" stroke="#ffffff" stroke-width="1.6" />
    </template>
    <template v-else-if="builtInKey === 'kimi'">
      <circle cx="10" cy="10" r="10" fill="#111827" />
      <path d="M12.8 4.6a6.1 6.1 0 100 10.8 6.8 6.8 0 010-10.8z" fill="#ffffff" />
    </template>
    <template v-else-if="builtInKey === 'mistral'">
      <rect width="20" height="20" rx="5" fill="#FF7000" />
      <path d="M4 15.2V7.2l3 4.1 3-4.1v8" stroke="#ffffff" stroke-width="1.7"
        stroke-linejoin="round" stroke-linecap="round" />
      <rect x="13" y="7.4" width="3" height="3" rx="0.7" fill="#FFD400" />
      <rect x="13" y="11.4" width="3" height="3.8" rx="0.7" fill="#ffffff" />
    </template>
    <template v-else-if="builtInKey === 'xai'">
      <circle cx="10" cy="10" r="10" fill="#0F172A" />
      <path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" />
    </template>
    <template v-else-if="builtInKey === 'groq'">
      <circle cx="10" cy="10" r="10" fill="#F55036" />
      <path d="M11.5 3.5L5.7 11h3.1l-.6 5.5L14.3 9h-3.1z" fill="#ffffff" />
    </template>
    <template v-else-if="builtInKey === 'azure'">
      <rect width="20" height="20" rx="5" fill="#0078D4" />
      <path d="M5.1 14.3l4.3-8.6h3.1l3.4 8.6h-2.6l-.7-1.9H8.4l-.8 1.9z" fill="#ffffff" />
    </template>
    <template v-else-if="builtInKey === 'ollama'">
      <circle cx="10" cy="10" r="10" fill="#ffffff" stroke="#E5E7EB" stroke-width="1" />
      <circle cx="10" cy="10.8" r="3.2" stroke="#111827" stroke-width="1.4" />
      <path d="M7.7 6.8V4.9M12.3 6.8V4.9" stroke="#111827" stroke-width="1.4" stroke-linecap="round" />
      <circle cx="8.9" cy="10.2" r="0.7" fill="#111827" />
      <circle cx="11.1" cy="10.2" r="0.7" fill="#111827" />
    </template>
    <template v-else>
      <circle cx="10" cy="10" r="10" fill="#9CA3AF" />
      <circle cx="10" cy="10" r="2.6" stroke="#ffffff" stroke-width="1.4" />
      <path d="M10 3.4v2.1M10 14.5v2.1M3.4 10h2.1M14.5 10h2.1M5.3 5.3l1.5 1.5M13.2 13.2l1.5 1.5M14.7 5.3l-1.5 1.5M6.8 13.2l-1.5 1.5"
        stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" />
    </template>
  </svg>
  <svg
    v-else
    :style="boxStyle"
    viewBox="0 0 20 20"
    aria-hidden="true"
    class="shrink-0 select-none"
  >
    <circle cx="10" cy="10" r="10" fill="#94A3B8" />
    <text x="10" y="10.4" text-anchor="middle" dominant-baseline="middle"
      fill="#ffffff" font-size="10" font-weight="600">{{ fallbackLetter }}</text>
  </svg>
</template>
