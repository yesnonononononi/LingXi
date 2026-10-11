<script setup lang="ts">
import { useI18n } from '../../../i18n';

defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="space-y-3.5 text-xs">
    <!--
      原「用户协议 / 隐私政策」入口仅弹 window.alert 占位文案，并非真实协议页面，故隐藏。
      待接入真实协议内容后再恢复。
    -->
    <div class="py-6 text-center text-gray-400 dark:text-gray-500">
      {{ t('settings.terms.unavailable') }}
    </div>
  </div>
</template>
