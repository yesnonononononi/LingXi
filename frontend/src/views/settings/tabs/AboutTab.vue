<script setup lang="ts">
/**
 * 设置 → 关于/更新。
 *
 * ⚠️ 本组件不解析任何版本声明、不构造任何 URL。它拿到什么显示什么：
 *    「不可跳过」的判据 `mandatory` 来自主进程（已验签的 forceupdate 或
 *    当前版本低于 minSupportedVersion），这里只负责渲染成不可跳过的交互形态。
 */
import { computed } from 'vue';
import { useAppUpdater } from '../../../composables/useAppUpdater';
import { useTheme } from '../../../composables/useTheme';
import { formatBytes } from '../../../types/update';

defineProps<{
  isDark?: boolean;
}>();

const { isDark } = useTheme();

const {
  supported,
  state,
  currentVersion,
  availableVersion,
  releaseNotes,
  mandatory,
  installable,
  percent,
  bytesPerSecond,
  statusText,
  busy,
  check,
  download,
  install,
  openLog,
} = useAppUpdater();

/**
 * 主按钮的形态：由状态机推导，避免多处置 truthy 判断导致口径不一致。
 *
 * ⚠️ 判「不可跳过」用 mandatory 而不是 forceupdate：
 *    mandatory 还覆盖「当前版本低于 minSupportedVersion」的情形。
 * ⚠️ 强制更新且尚未下载时按钮必须是「下载」而不是「安装」——
 *    安装入口有下载完成前置，直接指过去会点了没反应。
 */
const primary = computed(() => {
  switch (state.value) {
    case 'checking':
      return { label: '检查中…', action: 'none' as const };
    case 'available':
      return { label: mandatory.value ? '立即更新' : '下载更新', action: 'download' as const };
    case 'downloading':
      return { label: `下载中 ${percent.value}%`, action: 'none' as const };
    case 'downloaded':
      return { label: '安装并重启', action: 'install' as const };
    case 'installing':
      return { label: '正在安装…', action: 'none' as const };
    default:
      return { label: '检查更新', action: 'check' as const };
  }
});

async function onPrimary() {
  switch (primary.value.action) {
    case 'check':
      await check();
      break;
    case 'download':
      await download();
      break;
    case 'install':
      await install();
      break;
    default:
      break;
  }
}

const hasUpdate = computed(
  () => !!availableVersion.value && (state.value === 'available' || state.value === 'downloading' || state.value === 'downloaded')
);
</script>

<template>
  <div class="space-y-5">
    <!-- 当前版本 -->
    <div>
      <div class="text-xs font-semibold text-gray-800 dark:text-zinc-100 dark:text-glow-subtle mb-2.5 tracking-wide">
        版本信息
      </div>
      <div
        :class="[
          'rounded-2xl border p-4 space-y-3',
          isDark ? 'bg-white/[0.03] border-white/10' : 'bg-gray-50 border-gray-100',
        ]"
      >
        <div class="flex items-center justify-between">
          <span :class="['text-xs', isDark ? 'text-zinc-400' : 'text-gray-500']">当前版本</span>
          <span :class="['text-xs font-mono font-semibold', isDark ? 'text-zinc-100' : 'text-gray-900']">
            {{ currentVersion || '—' }}
          </span>
        </div>

        <div v-if="hasUpdate" class="flex items-center justify-between">
          <span :class="['text-xs', isDark ? 'text-zinc-400' : 'text-gray-500']">可用版本</span>
          <span class="flex items-center gap-1.5">
            <span
              v-if="mandatory"
              class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-500 dark:text-red-400"
            >
              强制
            </span>
            <span class="text-xs font-mono font-semibold text-blue-500 dark:text-blue-400">
              {{ availableVersion }}
            </span>
          </span>
        </div>

        <!-- 状态行 -->
        <div class="flex items-center justify-between pt-1">
          <span
            :class="[
              'text-xs',
              state === 'error' || (!installable && !!availableVersion)
                ? 'text-red-500 dark:text-red-400'
                : isDark
                  ? 'text-zinc-400'
                  : 'text-gray-500',
            ]"
          >
            {{ statusText }}
          </span>
        </div>

        <!-- 下载进度（仅下载中显示；不定态进度条不用百分比文案以免误导） -->
        <div v-if="state === 'downloading'" class="space-y-1.5">
          <div :class="['h-1.5 rounded-full overflow-hidden', isDark ? 'bg-white/10' : 'bg-gray-200']">
            <div
              class="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-[width] duration-300"
              :style="{ width: `${Math.max(percent, 2)}%` }"
            />
          </div>
          <div class="flex items-center justify-between">
            <span :class="['text-[10px] font-mono', isDark ? 'text-zinc-500' : 'text-gray-400']">
              {{ percent }}%
            </span>
            <span v-if="bytesPerSecond > 0" :class="['text-[10px] font-mono', isDark ? 'text-zinc-500' : 'text-gray-400']">
              {{ formatBytes(bytesPerSecond) }}/s
            </span>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="flex items-center gap-2 pt-1">
          <button
            type="button"
            :disabled="busy || !supported"
            @click="onPrimary"
            :class="[
              'px-4 py-2 rounded-xl text-xs font-semibold transition',
              busy || !supported
                ? isDark
                  ? 'bg-white/5 text-zinc-500 cursor-not-allowed'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : mandatory
                  ? 'bg-red-500 text-white hover:bg-red-600 shadow-sm cursor-pointer'
                  : 'bg-blue-500 text-white hover:bg-blue-600 shadow-sm cursor-pointer',
            ]"
          >
            {{ primary.label }}
          </button>

          <button
            v-if="!supported"
            type="button"
            disabled
            class="px-3 py-2 rounded-xl text-xs font-medium bg-transparent cursor-not-allowed"
            :class="isDark ? 'text-zinc-600' : 'text-gray-400'"
          >
            仅桌面客户端可用
          </button>
        </div>
      </div>
    </div>

    <!-- 更新说明 -->
    <div v-if="releaseNotes">
      <div class="text-xs font-semibold text-gray-800 dark:text-zinc-100 dark:text-glow-subtle mb-2.5 tracking-wide">
        更新内容
      </div>
      <div
        :class="[
          'rounded-2xl border p-4 text-xs leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto scrollbar-thin',
          isDark ? 'bg-white/[0.03] border-white/10 text-zinc-300' : 'bg-gray-50 border-gray-100 text-gray-700',
        ]"
      >{{ releaseNotes }}</div>
    </div>

    <!-- 排障入口：用户报「更新失败」时，让 TA 直接把这个日志发过来 -->
    <div v-if="supported">
      <button
        type="button"
        @click="openLog"
        :class="[
          'text-[11px] underline-offset-2 hover:underline transition cursor-pointer',
          isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-400 hover:text-gray-600',
        ]"
      >
        查看更新日志
      </button>
    </div>
  </div>
</template>
