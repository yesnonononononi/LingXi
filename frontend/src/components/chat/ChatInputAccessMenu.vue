<script setup lang="ts">
/**
 * 输入区「工作区权限」上拉框。
 *
 * <p>档位文案与警示判据全部读 `accessModePresentation`，与安全中心共用同一份真源：
 * 本地环境没有沙箱，只读档只剩「文件工具被禁用」，这里也必须照实说，不能只写「只读模式」。</p>
 *
 * <p>本组件不写配置：选中只是 emit 意图，由宿主落到 userConfig。档位是全局安全策略，
 * 输入区自己缓存一份就会和安全中心分叉。</p>
 */
import {computed} from 'vue';
import {Tick02Icon} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import type {AgentAccessMode, WorkspaceEnvType} from '../../types/chat';
import {
  isAccessModeMismatch,
  resolveAccessBadgeKey,
  resolveAccessImpactKey,
  resolveAccessPreset,
  resolveSandboxState,
} from '../../utils/accessModePresentation';
import {MUTED} from '../../utils/promptBarStyles';
import {t} from '../../i18n';

const props = defineProps<{
  isDark?: boolean;
  accessMode?: AgentAccessMode | string;
  envType?: WorkspaceEnvType | string;
}>();

const emit = defineEmits<{
  (e: 'select', mode: AgentAccessMode): void;
  (e: 'openSecurity'): void;
}>();

const MODES: AgentAccessMode[] = ['IN_WORKSPACE', 'READ_ONLY_IN_WORKSPACE', 'OUT_OF_WORKSPACE'];

const sandboxState = computed(() => resolveSandboxState(props.envType));

/** 后端下发的未知档位按「普通修改」展示（与徽标同一个兜底口径）。 */
const isSelected = (mode: AgentAccessMode): boolean =>
  resolveAccessPreset(mode) === resolveAccessPreset(props.accessMode);

const modeLabel = (mode: AgentAccessMode): string => t(resolveAccessBadgeKey(mode));

const modeImpact = (mode: AgentAccessMode): string => t(resolveAccessImpactKey(mode, sandboxState.value));

const modeWarn = (mode: AgentAccessMode): boolean => isAccessModeMismatch(mode, sandboxState.value);
</script>

<template>
  <!-- 面板贴合徽标上沿（bottom-full），宽度按「短标签 + 一行效果说明」定：档位名不再带环境后缀长句 -->
  <div
    class="bottom-full z-50 absolute left-0 w-[228px] p-1 rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
    :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
    role="menu"
  >
    <div class="px-2 pt-1 pb-1 text-lx-fs-xs font-medium select-none" :class="MUTED">
      {{ t('chat.input.accessMenuTitle') }}
    </div>

    <button
      v-for="mode in MODES"
      :key="mode"
      type="button"
      class="flex items-start gap-2 w-full px-2 py-1 rounded-lg text-lx-fs-lg leading-[18px] text-left bg-transparent border-0 outline-none cursor-pointer transition-colors hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]"
      :aria-checked="isSelected(mode)"
      role="menuitemradio"
      @click="emit('select', mode)"
    >
      <span class="flex-1 min-w-0">
        <span class="block truncate [color:var(--pb-ink)]">{{ modeLabel(mode) }}</span>
        <span
          class="block text-lx-fs-xs leading-snug mt-0.5"
          :class="modeWarn(mode) ? 'text-amber-500' : MUTED"
        >{{ modeImpact(mode) }}</span>
      </span>
      <HugeiconsIcon
        v-if="isSelected(mode)"
        :icon="Tick02Icon as IconArray"
        :size="13"
        :stroke-width="2.5"
        class="shrink-0 mt-0.5 [color:var(--pb-ink)]"
      />
    </button>

    <div class="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
      <button
        type="button"
        class="flex items-center w-full px-2 py-1 rounded-lg text-lx-fs-md leading-[18px] text-left bg-transparent border-0 outline-none cursor-pointer transition-colors [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]"
        @click="emit('openSecurity')"
      >
        <span class="truncate">{{ t('chat.input.accessMenuSecurity') }}</span>
      </button>
    </div>
  </div>
</template>
