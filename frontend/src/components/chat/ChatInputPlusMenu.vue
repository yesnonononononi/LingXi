<script setup lang="ts">
/**
 * 输入区「+」分组菜单：左侧一级分组，右侧对应二级浮层。
 *
 * <p>二级浮层挂在**各自分组行的 wrapper** 上（wrapper `relative` + 浮层 `left-full top-0`），
 * 因此浮层天然与所属行顶端对齐。历史原型用绝对定位 + JS 量 offsetTop，行高或顺序一变就错层，
 * 这里不需要任何测量代码。</p>
 *
 * <p>本组件只做展示与交互，数据一律由宿主注入、动作一律 emit 回宿主：
 * 团队 / 技能 / MCP 的加载与写入都在宿主，菜单不自己发请求，避免两处状态各自为政。</p>
 */
import {computed, ref, watch} from 'vue';
import {Tick02Icon} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import type {McpConnectionStateVO, McpVO, SkillVO, TeamVO} from '../../types/chat';
import {isImageAvatar} from '../../utils/avatar';
import {MUTED} from '../../utils/promptBarStyles';
import {t} from '../../i18n';

type PlusGroup = 'files' | 'mode' | 'teams' | 'skills' | 'mcp';

const GROUPS: {key: PlusGroup; labelKey: string}[] = [
  {key: 'files', labelKey: 'chat.input.plusFiles'},
  {key: 'mode', labelKey: 'chat.input.plusMode'},
  {key: 'teams', labelKey: 'chat.input.plusTeams'},
  {key: 'skills', labelKey: 'chat.input.plusSkills'},
  {key: 'mcp', labelKey: 'chat.input.plusMcp'},
];

const props = defineProps<{
  isDark?: boolean;
  isPlanMode: boolean;
  teams: TeamVO[];
  selectedTeamId?: string | number | null;
  skills: SkillVO[];
  skillsLoading: boolean;
  skillsError: string;
  mcpServers: McpVO[];
  mcpStates: McpConnectionStateVO[];
  mcpLoading: boolean;
  mcpError: string;
  /** 按 `String(server.id)` 标记该行动作进行中；进行中禁用按钮，避免连点发出两次请求。 */
  mcpBusy?: Record<string, boolean>;
  /** 打开时要直接展开的分组（`/team` 之类命令直达协作面板，不必再点一次）。 */
  initialGroup?: string | null;
}>();

const emit = defineEmits<{
  (e: 'uploadImage'): void;
  (e: 'updatePlanMode', planMode: boolean): void;
  (e: 'selectTeam', teamId: string | number | null): void;
  (e: 'createTeam'): void;
  (e: 'selectSkill', skill: SkillVO): void;
  (e: 'openMcpSettings'): void;
  /** 行内启停 / 重连同样只报告意图：请求与状态写入都在宿主，菜单不自己发请求。 */
  (e: 'toggleMcp', server: McpVO): void;
  (e: 'reconnectMcp', server: McpVO): void;
  /** 某个分组被展开：数据加载在宿主，菜单只报告意图（否则点开的永远是一张空面板）。 */
  (e: 'openGroup', group: PlusGroup): void;
}>();

/** 菜单行：二级浮层内所有可点项共用一套排版，避免各分支各写一份。 */
const ROW = 'flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-lx-fs-lg leading-[18px] text-left bg-transparent border-0 outline-none cursor-pointer transition-colors hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]';
const SEARCH_INPUT = 'w-full px-1.5 py-1 text-xs bg-transparent border-0 outline-none focus:outline-none focus:ring-0 select-text [color:var(--pb-ink)] placeholder:[color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)]';
const PANEL_SHELL = 'absolute left-full top-0 ml-2 w-[280px] p-2 rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]';

const activeGroup = ref<PlusGroup | null>(null);
const teamQuery = ref('');
const skillQuery = ref('');

// 宿主每次打开菜单都可能指定默认分组，跟着 prop 走而不是只在初始化时读一次
watch(
  () => props.initialGroup,
  (group) => { activeGroup.value = (group as PlusGroup | null) ?? null; },
  { immediate: true }
);

const toggleGroup = (key: PlusGroup): void => {
  const next = activeGroup.value === key ? null : key;
  activeGroup.value = next;
  if (next) emit('openGroup', next);
};

/** 浮层只换边框色，位置与高度全交给 CSS：测量 + 抬升那套会把布局正确性押在脚本时序上。 */
const panelStyle = computed<Record<string, string>>(() => ({
  borderColor: props.isDark !== false ? 'rgba(255,255,255,0.08)' : '#e4e4e7'
}));

const filteredTeams = computed<TeamVO[]>(() => {
  const query = teamQuery.value.trim().toLowerCase();
  if (!query) return props.teams;
  return props.teams.filter(team => (team.name ?? '').toLowerCase().includes(query));
});

const filteredSkills = computed<SkillVO[]>(() => {
  const query = skillQuery.value.trim().toLowerCase();
  if (!query) return props.skills;
  return props.skills.filter(skill =>
    skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query)
  );
});

/** 行内动作按钮：浮层只有 280px 宽，按钮固定不换行、不参与 flex 收缩，状态文案先让位。 */
const MCP_ACTION_BTN = 'shrink-0 px-1.5 py-0.5 rounded-md border-0 outline-none cursor-pointer whitespace-nowrap text-lx-fs-xs leading-[16px] transition-colors [background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] [color:var(--pb-ink)] hover:[background:color-mix(in_srgb,var(--pb-ink)_16%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed';

/** MCP 服务可能已配置但从未连过：状态缺失就只说「未连接」，不编造工具数。加载中整块只渲染占位，所以这里不必再判 loading。 */
const findMcpState = (server: McpVO): McpConnectionStateVO | undefined =>
  props.mcpStates.find(item => String(item.id) === String(server.id));

const mcpStatusText = (server: McpVO): string => {
  const state = findMcpState(server);
  if (!state) return t('chat.input.plusMcpDisconnected');
  switch (state.state) {
    case 'CONNECTED':
      return typeof state.toolCount === 'number'
        ? t('chat.input.plusMcpConnected', {count: state.toolCount})
        : t('chat.input.plusMcpConnectedNoCount');
    case 'FAILED':
      return t('chat.input.plusMcpFailed');
    case 'AUTHORIZATION_REQUIRED':
      return t('chat.input.plusMcpAuthRequired');
    case 'DISABLED':
      return t('chat.input.plusMcpDisabled');
    default:
      return t('chat.input.plusMcpDisconnected');
  }
};

const mcpStatusDot = (server: McpVO): string => {
  const state = findMcpState(server);
  if (!state) return 'bg-zinc-400';
  switch (state.state) {
    case 'CONNECTED':
      return 'bg-emerald-500';
    case 'FAILED':
      return 'bg-red-500';
    case 'AUTHORIZATION_REQUIRED':
      return 'bg-amber-500';
    default:
      return 'bg-zinc-400';
  }
};

type McpRowAction = 'ENABLE' | 'DISABLE' | 'RECONNECT' | 'AUTHORIZE';

/**
 * 一行只给一个动作，收敛成单一函数（模板里不写多重条件）。
 *
 * <p>配置态优先于运行态：`status === 0` 或状态表说 DISABLED 时，连接表里的残留值没有意义，
 * 只能「启用」；其余没有连接（缺失 / DISCONNECTED）与连接失败一样靠重建连接恢复，不另设按钮。</p>
 *
 * <p>需要授权的服务单独一档：重连只会再吃一次 401，把用户直接送到设置页的「去授权」才是下一步。</p>
 */
const resolveMcpAction = (server: McpVO): McpRowAction => {
  const state = findMcpState(server);
  if (server.status === 0 || state?.state === 'DISABLED') return 'ENABLE';
  if (state?.state === 'CONNECTED') return 'DISABLE';
  if (state?.state === 'AUTHORIZATION_REQUIRED') return 'AUTHORIZE';
  return 'RECONNECT';
};

const mcpActionLabel = (server: McpVO): string => {
  switch (resolveMcpAction(server)) {
    case 'ENABLE':
      return t('chat.input.plusMcpEnable');
    case 'DISABLE':
      return t('chat.input.plusMcpDisable');
    case 'AUTHORIZE':
      return t('chat.input.plusMcpAuthorize');
    default:
      return t('chat.input.plusMcpReconnect');
  }
};

const isMcpBusy = (server: McpVO): boolean => props.mcpBusy?.[String(server.id)] === true;

const runMcpAction = (server: McpVO): void => {
  if (isMcpBusy(server)) return;
  const action = resolveMcpAction(server);
  if (action === 'AUTHORIZE') {
    emit('openMcpSettings');
    return;
  }
  if (action === 'RECONNECT') {
    emit('reconnectMcp', server);
    return;
  }
  emit('toggleMcp', server);
};
</script>

<template>
  <div
    class="bottom-full z-50 absolute left-0 p-1.5 rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
    :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
    role="menu"
  >
    <div class="w-[188px]">
      <div v-for="group in GROUPS" :key="group.key">
        <button
          type="button"
          class="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-lx-fs-lg leading-[18px] text-left bg-transparent border-0 outline-none cursor-pointer transition-colors"
          :class="activeGroup === group.key
            ? '[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [color:var(--pb-ink)]'
            : '[color:var(--pb-ink)] hover:[background:color-mix(in_srgb,var(--pb-ink)_6%,transparent)]'"
          :aria-expanded="activeGroup === group.key"
          @click="toggleGroup(group.key)"
        >
          <span class="w-3.5 h-3.5 shrink-0 [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)]">
            <svg v-if="group.key === 'files'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h5l2 2h9v10H4z" />
              <path stroke-linecap="round" d="M12 12.5v4M10 14.5h4" />
            </svg>
            <svg v-else-if="group.key === 'mode'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 19c2-7 6-10 14-12-2 8-6 12-11 12H5z" />
              <path stroke-linecap="round" d="M8 16l4-4" />
            </svg>
            <svg v-else-if="group.key === 'teams'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <circle cx="9" cy="9" r="3.2" />
              <path stroke-linecap="round" d="M3.5 20a5.5 5.5 0 0111 0M16 6.5a3.2 3.2 0 010 6M17 20a5.2 5.2 0 00-1.6-3.7" />
            </svg>
            <svg v-else-if="group.key === 'skills'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 19L18 5M8 5h10v10" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" />
              <path stroke-linecap="round" d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />
            </svg>
          </span>
          <span class="flex-1 min-w-0 truncate">{{ t(group.labelKey) }}</span>
          <svg class="w-3 h-3 shrink-0 [color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <!-- 添加文件 -->
        <div
          v-if="activeGroup === group.key && group.key === 'files'"
          :class="PANEL_SHELL"
          :style="panelStyle"
          role="menu"
        >
          <button type="button" :class="ROW" @click="emit('uploadImage')">
            <span class="truncate [color:var(--pb-ink)]">{{ t('chat.input.plusUploadImage') }}</span>
          </button>
          <p class="px-2 py-1 text-xs leading-relaxed" :class="MUTED">{{ t('chat.input.plusPasteHint') }}</p>
        </div>

        <!-- 模式 -->
        <div
          v-else-if="activeGroup === group.key && group.key === 'mode'"
          :class="PANEL_SHELL"
          :style="panelStyle"
          role="menu"
        >
          <button type="button" :class="ROW" @click="emit('updatePlanMode', true)">
            <span class="flex-1 min-w-0 truncate [color:var(--pb-ink)]">{{ t('chat.input.plusModePlan') }}</span>
            <HugeiconsIcon v-if="isPlanMode" :icon="Tick02Icon as IconArray" :size="14" :stroke-width="2.5" class="shrink-0 [color:var(--pb-ink)]" />
          </button>
          <button type="button" :class="ROW" @click="emit('updatePlanMode', false)">
            <span class="flex-1 min-w-0 truncate [color:var(--pb-ink)]">{{ t('chat.input.plusModeAuto') }}</span>
            <HugeiconsIcon v-if="!isPlanMode" :icon="Tick02Icon as IconArray" :size="14" :stroke-width="2.5" class="shrink-0 [color:var(--pb-ink)]" />
          </button>
          <p class="px-2 py-1 text-xs leading-relaxed" :class="MUTED">{{ t('chat.input.plusModeHint') }}</p>
        </div>

        <!-- 协作（团队） -->
        <div
          v-else-if="activeGroup === group.key && group.key === 'teams'"
          :class="PANEL_SHELL"
          :style="panelStyle"
          role="menu"
        >
          <input v-model="teamQuery" type="text" :class="SEARCH_INPUT" :placeholder="t('chat.input.plusTeamSearch')" />
            <div class="max-h-32 overflow-y-auto scrollbar-thin mt-1">
            <button type="button" :class="ROW" @click="emit('selectTeam', null)">
              <span class="flex-1 min-w-0 truncate [color:var(--pb-ink)]">{{ t('chat.input.teamUnspecified') }}</span>
              <HugeiconsIcon v-if="!selectedTeamId" :icon="Tick02Icon as IconArray" :size="14" :stroke-width="2.5" class="shrink-0 [color:var(--pb-ink)]" />
            </button>
            <p v-if="!filteredTeams.length" class="px-2 py-2 text-xs text-center" :class="MUTED">
              {{ teams.length ? t('chat.input.plusTeamNoMatch') : t('chat.input.plusTeamEmpty') }}
            </p>
            <button
              v-for="team in filteredTeams"
              :key="team.id"
              type="button"
              :class="ROW"
              @click="emit('selectTeam', team.id)"
            >
              <img
                v-if="team.avatar && isImageAvatar(team.avatar)"
                :src="team.avatar"
                :alt="team.name"
                class="w-4 h-4 rounded-full object-cover shrink-0"
              />
              <span
                v-else-if="team.avatar"
                class="w-4 h-4 rounded-full flex items-center justify-center text-lx-fs-xs leading-none shrink-0 select-none [background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)]"
              >{{ team.avatar }}</span>
              <span class="flex-1 min-w-0 truncate [color:var(--pb-ink)]">{{ team.name }}</span>
              <HugeiconsIcon v-if="String(team.id) === String(selectedTeamId ?? '')" :icon="Tick02Icon as IconArray" :size="14" :stroke-width="2.5" class="shrink-0 [color:var(--pb-ink)]" />
            </button>
          </div>
          <div class="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
            <button type="button" :class="ROW" @click="emit('createTeam')">
              <span class="truncate [color:var(--pb-ink)]">{{ t('chat.input.plusCreateTeam') }}</span>
            </button>
          </div>
        </div>

        <!-- 技能 -->
        <div
          v-else-if="activeGroup === group.key && group.key === 'skills'"
          :class="PANEL_SHELL"
          :style="panelStyle"
          role="menu"
        >
          <input v-model="skillQuery" type="text" :class="SEARCH_INPUT" :placeholder="t('chat.input.searchSkill')" />
            <div class="max-h-32 overflow-y-auto scrollbar-thin mt-1">
            <!-- 加载中只留占位：占位和列表并存过一次，列表渲染后占位消失会把滚动框顶得一跳 -->
            <p v-if="skillsLoading" class="px-2 py-2 text-xs text-center" :class="MUTED">{{ t('chat.input.skillLoading') }}</p>
            <template v-else>
              <p v-if="skillsError" class="px-2 py-2 text-xs text-center text-red-500">{{ t('chat.input.skillLoadFailed') }}</p>
              <p v-else-if="!filteredSkills.length" class="px-2 py-2 text-xs text-center" :class="MUTED">
                {{ skills.length ? t('chat.input.noMatchedSkill') : t('chat.input.skillEmpty') }}
              </p>
              <button
                v-for="skill in filteredSkills"
                :key="skill.name"
                type="button"
                :class="ROW"
                :title="t('chat.input.skillFillTemplate', {name: skill.name})"
                @click="emit('selectSkill', skill)"
              >
                <span class="shrink-0 max-w-[45%] truncate font-medium [color:var(--pb-ink)]">{{ skill.name }}</span>
                <span class="flex-1 min-w-0 truncate text-right" :class="MUTED">{{ skill.description }}</span>
              </button>
            </template>
          </div>
        </div>

        <!-- MCP -->
        <div
          v-else-if="activeGroup === group.key && group.key === 'mcp'"
          :class="PANEL_SHELL"
          :style="panelStyle"
          role="menu"
        >
            <div class="max-h-32 overflow-y-auto scrollbar-thin">
            <!-- 同上：加载中只有占位。每行右侧不再各自复读「正在加载」，那是同一件事说五遍 -->
            <p v-if="mcpLoading" class="px-2 py-2 text-xs text-center" :class="MUTED">{{ t('chat.input.plusMcpLoading') }}</p>
            <template v-else>
              <p v-if="mcpError" class="px-2 py-2 text-xs text-center text-red-500 break-all">{{ mcpError }}</p>
              <p v-else-if="!mcpServers.length" class="px-2 py-2 text-xs text-center" :class="MUTED">{{ t('chat.input.plusMcpEmpty') }}</p>
              <!-- 行容器必须是 div：HTML 不允许 button 嵌套 button，左侧「打开设置」与右侧动作各是一个 button -->
              <div
                v-for="server in mcpServers"
                :key="server.id"
                class="flex items-center justify-between gap-2 w-full px-2 py-1.5 rounded-lg text-lx-fs-lg leading-[18px] transition-colors hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]"
                :data-testid="`plus-mcp-row-${server.id}`"
              >
                <button
                  type="button"
                  class="flex items-center gap-2 flex-1 min-w-0 px-0 py-0 text-left bg-transparent border-0 outline-none cursor-pointer"
                  @click="emit('openMcpSettings')"
                >
                  <span class="w-2 h-2 rounded-full shrink-0" :class="mcpStatusDot(server)" />
                  <span class="min-w-0 truncate [color:var(--pb-ink)]">{{ server.name }}</span>
                </button>
                <div class="flex items-center gap-1.5 min-w-0 justify-end">
                  <span class="min-w-0 truncate text-xs" :class="MUTED">{{ mcpStatusText(server) }}</span>
                  <button
                    type="button"
                    :class="MCP_ACTION_BTN"
                    :disabled="isMcpBusy(server)"
                    :aria-busy="isMcpBusy(server) ? 'true' : undefined"
                    :aria-label="`${mcpActionLabel(server)} ${server.name}`"
                    :data-testid="`plus-mcp-action-${server.id}`"
                    @click="runMcpAction(server)"
                  >{{ mcpActionLabel(server) }}</button>
                </div>
              </div>
            </template>
          </div>
          <div class="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
            <button type="button" :class="ROW" @click="emit('openMcpSettings')">
              <span class="truncate [color:var(--pb-ink)]">{{ t('chat.input.plusMcpSettings') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
