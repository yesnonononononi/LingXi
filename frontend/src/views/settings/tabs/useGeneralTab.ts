import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme } from '../../../composables/useTheme';
import { UserConfigAPI } from '../../../services/api';
import type { AgentAccessMode, CommandApprovalPolicyType } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { normalizeAccessMode, normalizeCommandApprovalPolicy } from '../../../utils/enum';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../../../utils/apiConfig';

export function useGeneralTab(emit: (e: 'modelUpdated') => void) {
  // 主题设置
  const { setTheme } = useTheme();
  const themeMode = ref<'light' | 'dark' | 'system'>('system');

  // 语言与通用配置
  const language = ref('跟随系统');
  const isLanguageOpen = ref(false);
  const languageOptions = ['跟随系统', '简体中文', 'English'];

  // 执行环境设置 (可选本地/沙箱，默认沙箱)
  const executionEnv = ref<'本地' | '沙箱' | '未知'>('未知');
  const isExecutionEnvOpen = ref(false);
  const executionEnvOptions: ('本地' | '沙箱')[] = ['本地', '沙箱'];

  // 1. 工作空间权限 (对应 UserConfigVO.accessMode)
  const accessMode = ref<AgentAccessMode>('IN_WORKSPACE');
  const isAccessModeOpen = ref(false);
  const accessModeOptions: { label: string; value: AgentAccessMode; desc: string }[] = [
    { label: '工作区内修改', value: 'IN_WORKSPACE', desc: '仅限在工作区根目录下读写 (推荐)' },
    { label: '只读模式', value: 'READ_ONLY_IN_WORKSPACE', desc: '仅分析与建议，不修改文件' },
    { label: '完全访问', value: 'OUT_OF_WORKSPACE', desc: '允许访问工作区外部系统资源' }
  ];

  // 2. 工具权限 (对应 UserConfigVO.commandApprovalPolicy)
  const commandApprovalPolicy = ref<CommandApprovalPolicyType>('DANGEROUS_BLOCK');
  const isCommandApprovalPolicyOpen = ref(false);
  const commandApprovalPolicyOptions: { label: string; value: CommandApprovalPolicyType; desc: string }[] = [
    { label: '危险拦截', value: 'DANGEROUS_BLOCK', desc: '高危敏感命令需人工确认 (推荐)' },
    { label: '逐条确认', value: 'PRE_EXEC_CONFIRM', desc: '所有工具与命令执行前逐条确认' },
    { label: '完全放行', value: 'FULL_ACCESS', desc: '自主执行所有命令，不弹窗询问' }
  ];

  const currentAccessModeLabel = computed(() => {
    return accessModeOptions.find(o => o.value === accessMode.value)?.label || '工作区内修改';
  });

  const currentCommandApprovalPolicyLabel = computed(() => {
    return commandApprovalPolicyOptions.find(o => o.value === commandApprovalPolicy.value)?.label || '危险拦截';
  });

  const toggleLanguageDropdown = (e?: Event) => {
    e?.stopPropagation();
    isLanguageOpen.value = !isLanguageOpen.value;
    if (isLanguageOpen.value) {
      isExecutionEnvOpen.value = false;
      isAccessModeOpen.value = false;
      isCommandApprovalPolicyOpen.value = false;
    }
  };

  const toggleExecutionEnvDropdown = (e?: Event) => {
    e?.stopPropagation();
    isExecutionEnvOpen.value = !isExecutionEnvOpen.value;
    if (isExecutionEnvOpen.value) {
      isLanguageOpen.value = false;
      isAccessModeOpen.value = false;
      isCommandApprovalPolicyOpen.value = false;
    }
  };

  const toggleAccessModeDropdown = (e?: Event) => {
    e?.stopPropagation();
    isAccessModeOpen.value = !isAccessModeOpen.value;
    if (isAccessModeOpen.value) {
      isLanguageOpen.value = false;
      isExecutionEnvOpen.value = false;
      isCommandApprovalPolicyOpen.value = false;
    }
  };

  const toggleCommandApprovalPolicyDropdown = (e?: Event) => {
    e?.stopPropagation();
    isCommandApprovalPolicyOpen.value = !isCommandApprovalPolicyOpen.value;
    if (isCommandApprovalPolicyOpen.value) {
      isLanguageOpen.value = false;
      isExecutionEnvOpen.value = false;
      isAccessModeOpen.value = false;
    }
  };

  const handleSelectExecutionEnv = async (opt: '本地' | '沙箱') => {
    executionEnv.value = opt;
    isExecutionEnvOpen.value = false;
    const type = opt === '本地' ? 'local' : 'sandbox';
    // 单一来源：类型只落库（/config/current/update），不再写本地缓存
    try {
      await UserConfigAPI.updateCurrent({ type });
      emit('modelUpdated');
    } catch (err) {
      console.error('更新工作空间类型失败:', err);
    }
  };

  const handleSelectAccessMode = async (opt: AgentAccessMode) => {
    accessMode.value = opt;
    isAccessModeOpen.value = false;
    try {
      await UserConfigAPI.updateCurrent({ accessMode: opt });
      emit('modelUpdated');
    } catch (err) {
      console.error('更新工作空间权限失败:', err);
    }
  };

  const handleSelectCommandApprovalPolicy = async (opt: CommandApprovalPolicyType) => {
    commandApprovalPolicy.value = opt;
    isCommandApprovalPolicyOpen.value = false;
    try {
      await UserConfigAPI.updateCurrent({ commandApprovalPolicy: opt });
      emit('modelUpdated');
    } catch (err) {
      console.error('更新工具权限失败:', err);
    }
  };

  const closeGeneralDropdowns = () => {
    isLanguageOpen.value = false;
    isExecutionEnvOpen.value = false;
    isAccessModeOpen.value = false;
    isCommandApprovalPolicyOpen.value = false;
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('.language-dropdown-container')) {
      isLanguageOpen.value = false;
    }
    if (!target?.closest('.execution-env-dropdown-container')) {
      isExecutionEnvOpen.value = false;
    }
    if (!target?.closest('.access-mode-dropdown-container')) {
      isAccessModeOpen.value = false;
    }
    if (!target?.closest('.command-policy-dropdown-container')) {
      isCommandApprovalPolicyOpen.value = false;
    }
  };

  const handleSelectTheme = (mode: 'light' | 'dark' | 'system') => {
    themeMode.value = mode;
    if (mode === 'light') {
      setTheme('light');
      void UserConfigAPI.updateCurrent({ renderTheme: 'LIGHT' });
    } else if (mode === 'dark') {
      setTheme('dark');
      void UserConfigAPI.updateCurrent({ renderTheme: 'DARK' });
    } else {
      // 跟随系统
      const isSysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(isSysDark ? 'dark' : 'light');
      localStorage.removeItem('lingxi-theme');
      void UserConfigAPI.updateCurrent({ renderTheme: isSysDark ? 'DARK' : 'LIGHT' });
    }
  };

  onMounted(async () => {
    const saved = localStorage.getItem('lingxi-theme');
    if (saved === 'light') themeMode.value = 'light';
    else if (saved === 'dark') themeMode.value = 'dark';
    else themeMode.value = 'system';

    try {
      const res = await UserConfigAPI.current();
      if (isOk(res.code) && res.data) {
        // 同步后端持久化的 renderTheme（未在本地明确设置时采纳服务端偏好）
        if (res.data.renderTheme && !saved) {
          const remoteTheme = res.data.renderTheme.toUpperCase() === 'DARK' ? 'dark' : 'light';
          setTheme(remoteTheme);
          themeMode.value = remoteTheme;
        }

        // 枚举校验收敛到 utils/enum，不再 as 强转后靠 includes 白名单兜底
        const mode = normalizeAccessMode(res.data.accessMode);
        if (mode) accessMode.value = mode;

        const policy = normalizeCommandApprovalPolicy(res.data.commandApprovalPolicy);
        if (policy) commandApprovalPolicy.value = policy;
      }
      // 契约来源：docs/frontend-backend-contract.md §5。
      // 后端下发的是 WorkspaceType 枚举名 SAND_BOX / LOCAL / NONE（非小写 code）。
      // 查询失败或下发 NONE 时显示「未知」——「未知」与「沙箱」语义不同，
      // 兜底成沙箱会让用户误判当前安全边界。
      const env = await UserConfigAPI.currentWorkspaceType();
      executionEnv.value = env === 'LOCAL' ? '本地' : env === 'SAND_BOX' ? '沙箱' : '未知';
    } catch {
      executionEnv.value = '未知';
    }

    window.addEventListener('click', handleDocumentClick);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('click', handleDocumentClick);
  });

  // 后端服务地址配置 (桌面客户端 / 局域网 / 远程直连)
  const apiBaseUrl = ref(getApiBaseUrl() || 'http://localhost:8088');
  const isApiUrlSaved = ref(false);

  const handleSaveApiUrl = () => {
    setApiBaseUrl(apiBaseUrl.value);
    apiBaseUrl.value = getApiBaseUrl() || 'http://localhost:8088';
    isApiUrlSaved.value = true;
    setTimeout(() => {
      isApiUrlSaved.value = false;
    }, 2000);
  };

  const handleResetApiUrl = () => {
    resetApiBaseUrl();
    apiBaseUrl.value = getApiBaseUrl() || 'http://localhost:8088';
  };

  return {
    themeMode,
    language,
    isLanguageOpen,
    languageOptions,
    executionEnv,
    isExecutionEnvOpen,
    executionEnvOptions,
    accessMode,
    isAccessModeOpen,
    accessModeOptions,
    currentAccessModeLabel,
    commandApprovalPolicy,
    isCommandApprovalPolicyOpen,
    commandApprovalPolicyOptions,
    currentCommandApprovalPolicyLabel,
    apiBaseUrl,
    isApiUrlSaved,
    handleSaveApiUrl,
    handleResetApiUrl,
    toggleLanguageDropdown,
    toggleExecutionEnvDropdown,
    toggleAccessModeDropdown,
    toggleCommandApprovalPolicyDropdown,
    handleSelectExecutionEnv,
    handleSelectAccessMode,
    handleSelectCommandApprovalPolicy,
    closeGeneralDropdowns,
    handleSelectTheme,
  };
}
