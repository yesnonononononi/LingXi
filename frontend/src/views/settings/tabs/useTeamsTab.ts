import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { TeamAPI, AgentAPI } from '../../../services/api';
import type { TeamVO, AgentVO } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';

/**
 * 团队描述上限。**必须与后端 `Team.MAX_DESCRIPTION_LENGTH` 及 `init.sql` 里
 * `team.description` 的列宽一致** —— 这三处曾各写一份，前端这份漂成了 500：
 * 前端先拦、拦不住时后端也放行（后端本就是 1000），最后在 DB 列宽上炸掉。
 * 改这里时三处一起改。
 */
const TEAM_DESCRIPTION_MAX_LENGTH = 1000;

export function useTeamsTab(emit: (e: 'modelUpdated') => void) {
  const { t } = useI18n();
  const teamsList = ref<TeamVO[]>([]);
  const isTeamsLoading = ref(false);
  const teamsErrorMsg = ref('');
  const isEditingOrAddingTeam = ref(false);
  const editingTeamId = ref<number | string | null>(null);
  const teamForm = ref({
    name: '',
    description: '',
    commanderAgentId: '' as number | string,
    agentIds: [] as (number | string)[],
  });
  const teamFormError = ref('');
  const isSubmittingTeam = ref(false);
  const teamToast = ref('');
  let teamToastTimer: number | undefined;

  const agentsList = ref<AgentVO[]>([]);

  const showTeamToast = (msg: string) => {
    teamToast.value = msg;
    if (teamToastTimer) window.clearTimeout(teamToastTimer);
    teamToastTimer = window.setTimeout(() => {
      teamToast.value = '';
    }, 2500);
  };

  const loadTeams = async () => {
    isTeamsLoading.value = true;
    teamsErrorMsg.value = '';
    try {
      const res = await TeamAPI.list(1, 100);
      if (isOk(res.code)) {
        teamsList.value = res.data?.records ?? [];
            } else {
        teamsErrorMsg.value = t('settings.teams.errLoadList');
      }
    } catch {
      teamsErrorMsg.value = t('settings.teams.errLoadList');
    } finally {
      isTeamsLoading.value = false;
    }
  };

  const loadAgents = async () => {
    try {
      const res = await AgentAPI.list(1, 100);
      if (isOk(res.code)) {
        agentsList.value = res.data?.records ?? [];
      }
    } catch (e) {
      console.error('加载 Agent 列表失败:', e);
    }
  };

    const getAgentName = (agentId?: number | string) => {
    if (!agentId) return '';
    const found = agentsList.value.find(a => String(a.id) === String(agentId));
    return found?.name || t('settings.teams.agentFallback', { id: agentId });
  };

  const startAddTeam = () => {
    editingTeamId.value = null;
    teamForm.value = {
      name: '',
      description: '',
      commanderAgentId: '',
      agentIds: [],
    };
    teamFormError.value = '';
    isEditingOrAddingTeam.value = true;
  };

  const startEditTeam = (team: TeamVO) => {
    editingTeamId.value = team.id;
    const memberIds = team.agents?.map(a => a.id) || [];
    const allIds = Array.from(new Set([...memberIds, ...(team.commanderAgentId ? [team.commanderAgentId] : [])]));
    teamForm.value = {
      name: team.name || '',
      description: team.description || '',
      commanderAgentId: team.commanderAgentId ?? (allIds[0] ?? ''),
      agentIds: allIds,
    };
    teamFormError.value = '';
    isEditingOrAddingTeam.value = true;
  };

  const cancelTeamForm = () => {
    isEditingOrAddingTeam.value = false;
    editingTeamId.value = null;
    teamFormError.value = '';
  };

  const toggleTeamMember = (agentId: number | string) => {
    const index = teamForm.value.agentIds.indexOf(agentId);
    if (index >= 0) {
      teamForm.value.agentIds.splice(index, 1);
      if (teamForm.value.commanderAgentId === agentId) {
        teamForm.value.commanderAgentId = teamForm.value.agentIds[0] || '';
      }
    } else {
      teamForm.value.agentIds.push(agentId);
      if (!teamForm.value.commanderAgentId) {
        teamForm.value.commanderAgentId = agentId;
      }
    }
  };

  const selectedTeamAgents = computed(() => {
    return agentsList.value.filter(a => teamForm.value.agentIds.includes(a.id));
  });

  const handleSaveTeam = async () => {
    teamFormError.value = '';
    const trimmedName = teamForm.value.name.trim();
        if (!trimmedName) {
      teamFormError.value = t('settings.teams.errNameRequired');
      return;
    }
    if (trimmedName.length > 100) {
      teamFormError.value = t('settings.teams.errNameTooLong');
      return;
    }
    if (teamForm.value.description
      && teamForm.value.description.trim().length > TEAM_DESCRIPTION_MAX_LENGTH) {
      teamFormError.value = t('settings.teams.errDescTooLong', { max: TEAM_DESCRIPTION_MAX_LENGTH });
      return;
    }
    if (teamForm.value.agentIds.length === 0) {
      teamFormError.value = t('settings.teams.errMembersRequired');
      return;
    }
    if (teamForm.value.agentIds.length > 10) {
      teamFormError.value = t('settings.teams.errTooManyMembers');
      return;
    }
    if (!teamForm.value.commanderAgentId) {
      teamFormError.value = t('settings.teams.errCommanderRequired');
      return;
    }
    if (!teamForm.value.agentIds.includes(teamForm.value.commanderAgentId)) {
      teamFormError.value = t('settings.teams.errCommanderNotMember');
      return;
    }

    isSubmittingTeam.value = true;
    try {
      if (editingTeamId.value) {
        const res = await TeamAPI.update({
          id: editingTeamId.value,
          name: trimmedName,
          description: teamForm.value.description.trim(),
          commanderAgentId: teamForm.value.commanderAgentId,
          agentIds: [...teamForm.value.agentIds],
        });
                if (isOk(res.code)) {
          showTeamToast(t('settings.teams.toastUpdated'));
          isEditingOrAddingTeam.value = false;
          await loadTeams();
          emit('modelUpdated');
        } else {
          teamFormError.value = res.errMsg || t('settings.teams.errUpdate');
        }
      } else {
        const res = await TeamAPI.add({
          name: trimmedName,
          description: teamForm.value.description.trim() || undefined,
          commanderAgentId: teamForm.value.commanderAgentId,
          agentIds: [...teamForm.value.agentIds],
        });
                if (isOk(res.code)) {
          showTeamToast(t('settings.teams.toastCreated'));
          isEditingOrAddingTeam.value = false;
          await loadTeams();
          emit('modelUpdated');
        } else {
          teamFormError.value = res.errMsg || t('settings.teams.errCreate');
        }
      }
    } catch (e: any) {
      teamFormError.value = e?.message || t('settings.teams.errSave');
    } finally {
      isSubmittingTeam.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteTeam = async (team: TeamVO) => {
        const confirmed = await confirm({
      title: t('settings.teams.confirmDeleteTitle'),
      content: t('settings.teams.confirmDeleteContent', { name: team.name }),
      type: 'danger',
      confirmText: t('common.confirmDelete'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;

    try {
      const res = await TeamAPI.delById(team.id);
      if (isOk(res.code)) {
        showTeamToast(t('settings.teams.toastDeleted'));
        await loadTeams();
        emit('modelUpdated');
      } else {
        showTeamToast(res.errMsg || t('settings.teams.errDelete'));
      }
    } catch {
      showTeamToast(t('settings.teams.errDeleteException'));
    }
  };

  onMounted(() => {
    loadTeams();
    loadAgents();
  });

  onBeforeUnmount(() => {
    if (teamToastTimer) window.clearTimeout(teamToastTimer);
  });

  return {
    teamsList,
    isTeamsLoading,
    teamsErrorMsg,
    isEditingOrAddingTeam,
    editingTeamId,
    teamForm,
    teamFormError,
    isSubmittingTeam,
    teamToast,
    agentsList,
    getAgentName,
    loadTeams,
    startAddTeam,
    startEditTeam,
    cancelTeamForm,
    toggleTeamMember,
    selectedTeamAgents,
    handleSaveTeam,
    handleDeleteTeam,
  };
}
