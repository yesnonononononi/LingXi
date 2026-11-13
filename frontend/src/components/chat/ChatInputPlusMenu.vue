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
import {computed, nextTick, ref, watch} from 'vue';
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
/** 当前展开的二级浮层（同一时刻只有一个渲染，五处复用同一个 setter）。 */
const panelEl = ref<HTMLElement | null>(null);
/** 浮层向上偏移量：窗口太矮时把浮层整体抬起，避免被任务栏/窗口底边切掉。 */
const panelLift = ref(0);

const PANEL_VIEWPORT_MARGIN = 12;

/** `ref` 写在 v-for 里会被收集成数组，用函数 ref 只保留当前展开的那个面板。 */
const setPanelRef = (el: unknown): void => {
  if (el) panelEl.value = el as HTMLElement;
};

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

const panelStyle = computed<Record<string, string>>(() => ({
  borderColor: props.isDark !== false ? 'rgba(255,255,255,0.08)' : '#e4e4e7',
  marginTop: panelLift.value ? `${panelLift.value}px` : '0px'
}));

/**
 * 浮层按「分组行顶端对齐」定位，行越靠下、窗口越矮，底部越容易被裁。
 *
 * <p>这里只做一次渲染后测量，把超出视口底部的部分抬回来；不测量就该裁，
 * 改成「固定向上展开」又会让上排分组跑出顶部。</p>
 */
watch(activeGroup, async (group) => {
  panelLift.value = 0;
  if (!group) return;
  await nextTick();
  const panel = panelEl.value;
  // 内存渲染器（组件用例）没有布局信息：量不到就保持原位
  if (!panel || typeof panel.getBoundingClientRect !== 'function') return;
  const viewportHeight = window.innerHeight;
  if (!viewportHeight) return;
  const overflow = panel.getBoundingClientRect().bottom - (viewportHeight - PANEL_VIEWPORT_MARGIN);
  if (overflow > 0) panelLift.value = -Math.ceil(overflow);
});

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

/** MCP 服务可能已配置但从未连过：状态缺失就只说「未连接」，不编造工具数。加载中整块只渲染占位，所以这里不必再判 loading。 */
const mcpStatusText = (server: McpVO): string => {
  const state = props.mcpStates.find(item => String(item.id) === String(server.id));
  if (!state) return t('chat.input.plusMcpDisconnected');
  switch (state.state) {
    case 'CONNECTED':
      return typeof state.toolCount === 'number'
        ? t('chat.input.plusMcpConnected', {count: state.toolCount})
        : t('chat.input.plusMcpConnectedNoCount');
    case 'FAILED':
      return t('chat.input.plusMcpFailed');
    case 'DISABLED':
      return t('chat.input.plusMcpDisabled');
    default:
      return t('chat.input.plusMcpDisconnected');
  }
};

const mcpStatusDot = (server: McpVO): string => {
  const state = props.mcpStates.find(item => String(item.id) === String(server.id));
  if (!state) return 'bg-zinc-400';
  switch (state.state) {
    case 'CONNECTED':
      return 'bg-emerald-500';
    case 'FAILED':
      return 'bg-red-500';
    default:
      return 'bg-zinc-400';
  }
};
</script>

<template>
  <div
    class="bottom-full z-50 absolute left-0 p-1.5 rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
    :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
    role="menu"
  >
    <div class="w-[188px]">
      <div v-for="group in GROUPS" :key="group.key" class="relative">
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
          :ref="setPanelRef"
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
          :ref="setPanelRef"
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
          :ref="setPanelRef"
          :style="panelStyle"
          role="menu"
        >
          <input v-model="teamQuery" type="text" :class="SEARCH_INPUT" :placeholder="t('chat.input.plusTeamSearch')" />
          <div class="max-h-44 overflow-y-auto scrollbar-thin mt-1">
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
          :ref="setPanelRef"
          :style="panelStyle"
          role="menu"
        >
          <input v-model="skillQuery" type="text" :class="SEARCH_INPUT" :placeholder="t('chat.input.searchSkill')" />
          <div class="max-h-44 overflow-y-auto scrollbar-thin mt-1">
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
          :ref="setPanelRef"
          :style="panelStyle"
          role="menu"
        >
          <div class="max-h-44 overflow-y-auto scrollbar-thin">
            <!-- 同上：加载中只有占位。每行右侧不再各自复读「正在加载」，那是同一件事说五遍 -->
            <p v-if="mcpLoading" class="px-2 py-2 text-xs text-center" :class="MUTED">{{ t('chat.input.plusMcpLoading') }}</p>
            <template v-else>
              <p v-if="mcpError" class="px-2 py-2 text-xs text-center text-red-500">{{ t('chat.input.plusMcpFailed') }}</p>
              <p v-else-if="!mcpServers.length" class="px-2 py-2 text-xs text-center" :class="MUTED">{{ t('chat.input.plusMcpEmpty') }}</p>
              <button
                v-for="server in mcpServers"
                :key="server.id"
                type="button"
                :class="ROW"
                @click="emit('openMcpSettings')"
              >
                <span class="w-2 h-2 rounded-full shrink-0" :class="mcpStatusDot(server)" />
                <span class="flex-1 min-w-0 truncate [color:var(--pb-ink)]">{{ server.name }}</span>
                <span class="shrink-0 text-xs" :class="MUTED">{{ mcpStatusText(server) }}</span>
              </button>
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
