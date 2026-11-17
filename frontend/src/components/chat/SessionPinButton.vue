<!--
  会话行内的置顶 / 取消置顶按钮。
  亮色自绘行与暗色 BranchedMenu 的行内操作共用本组件：图标与交互只有一处定义。
-->
<script setup lang="ts">
import {t} from '../../i18n';
import {PIN_PATH, UNPIN_PATH} from '../../utils/sessionPinIcons';

defineProps<{ pinned?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    data-testid="session-pin-toggle"
    :aria-pressed="pinned === true ? 'true' : 'false'"
    :title="pinned === true ? t('chat.sidebar.unpin') : t('chat.sidebar.pin')"
    :class="[
      'p-0.5 transition cursor-pointer',
      pinned === true ? 'text-amber-500 hover:text-amber-600' : 'hover:text-blue-500'
    ]"
    @click.stop="emit('toggle')"
  >
    <svg class="w-3 h-3" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
      <path :d="pinned === true ? UNPIN_PATH : PIN_PATH" />
    </svg>
  </button>
</template>
