<script setup lang="ts">
/**
 * 输入区「工作区权限」上拉框。
 *
 * <p>档位名与警示判据全部读 `accessModePresentation`，与安全中心共用同一份真源：
 * 本地环境没有沙箱，只读档只剩「文件工具被禁用」，这里也必须照实说。</p>
 *
 * <p>「沙箱拦得住谁」这条约束不分档位、只分环境，所以不写在每一档下面，改成标题旁常驻的感叹号悬停说明：
 * 沙箱里它拦终端不拦文件，本地两个都不拦。非沙箱环境下图标转成警示色，提示这份权限清单本身就是漏的。</p>
 *
 * <p>本组件不写配置：选中只是 emit 意图，由宿主落到 userConfig。档位是全局安全策略，
 * 输入区自己缓存一份就会和安全中心分叉。</p>
 */
import {computed} from 'vue';
import {Tick02Icon, AlertCircleIcon} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import type {AgentPermissionMode, WorkspaceEnvType} from '../../types/chat';
import {
  isAccessModeMismatch,
  isTerminalOutsideAccessControl,
  resolveAccessBadgeKey,
  resolveAccessMenuDescKey,
  resolveAccessPreset,
  resolveSandboxState,
  resolveTerminalCaveatKey,
} from '../../utils/accessModePresentation';
import {MUTED} from '../../utils/promptBarStyles';
import {t} from '../../i18n';

const props = defineProps<{
  isDark?: boolean;
  accessMode?: AgentPermissionMode | string;
  envType?: WorkspaceEnvType | string;
}>();

const emit = defineEmits<{
  (e: 'select', mode: AgentPermissionMode): void;
  (e: 'openSecurity'): void;
}>();

const MODES: AgentPermissionMode[] = ['APPROVAL_REQUIRED', 'DELEGATED_APPROVAL', 'FULL_ACCESS'];

const sandboxState = computed(() => resolveSandboxState(props.envType));

/** 后端下发的未知档位按「审批模式」展示（与徽标同一个兜底口径）。 */
const isSelected = (mode: AgentPermissionMode): boolean =>
  resolveAccessPreset(mode) === resolveAccessPreset(props.accessMode);

/** 终端不受档位约束时的悬停提示：档位文案里不再重复这段长句，改成标题旁常驻感叹号的悬停说明。 */
const terminalCaveatVisible = computed<boolean>(() => isTerminalOutsideAccessControl(sandboxState.value));

/** 悬停文案随环境切换：沙箱只拦终端，本地谁都拦不住。 */
const terminalCaveat = computed<string>(() => t(resolveTerminalCaveatKey(sandboxState.value)));

const modeLabel = (mode: AgentPermissionMode): string => t(resolveAccessBadgeKey(mode));

const modeImpact = (mode: AgentPermissionMode): string => t(resolveAccessMenuDescKey(mode));

const modeWarn = (mode: AgentPermissionMode): boolean => isAccessModeMismatch(mode, sandboxState.value);
</script>

<template>
  <!-- 面板贴合徽标上沿（bottom-full），宽度按「短标签 + 一行效果说明」定：档位名不再带环境后缀长句 -->
  <div
    class="bottom-full z-50 absolute left-0 w-[228px] p-1 rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
    :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
    role="menu"
  >
    <div class="flex items-center gap-1 px-2 pt-1 pb-1 select-none">
      <span class="text-lx-fs-xs font-medium" :class="MUTED">{{ t('chat.input.accessMenuTitle') }}</span>
      <!-- 档位只约束文件工具；终端与命令执行在非沙箱环境照样越界，这条长约束改成常驻悬停说明，别再撑三行 -->
      <span
        class="inline-grid shrink-0 place-items-center cursor-help"
        :class="terminalCaveatVisible ? 'text-amber-500' : MUTED"
        :title="terminalCaveat"
        :aria-label="terminalCaveat"
        data-testid="chat-access-terminal-caveat"
      >
        <HugeiconsIcon :icon="AlertCircleIcon as IconArray" :size="12" :stroke-width="2" />
      </span>
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
