import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme, THEME_STORAGE_KEY } from '../../../composables/useTheme';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import type { AgentAccessMode, CommandApprovalPolicyType, WorkspaceEnvType } from '../../../types/chat';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../../../utils/apiConfig';
import { useI18n } from '../../../i18n';
import type { LocalePreference } from '../../../i18n';

export function useGeneralTab(emit: (e: 'modelUpdated') => void) {
  const userConfig = useUserConfigStore();
  const { t, preference, setPreference } = useI18n();

  // 主题设置：内存态在 useTheme，落库走 userConfigStore
  const { setTheme } = useTheme();
  const themeMode = ref<'light' | 'dark' | 'system'>('system');

  // 语言设置：偏好与持久化在 i18n 单例，此处仅提供下拉所需的响应式选项
  const isLanguageOpen = ref(false);
  const languageOptions = computed<{ value: LocalePreference; label: string }[]>(() => [
    { value: 'system', label: t('settings.general.langSystem') },
    { value: 'zh-CN', label: t('settings.general.langZh') },
    { value: 'en-US', label: t('settings.general.langEn') },
  ]);
  const currentLanguageLabel = computed(
    () => languageOptions.value.find(o => o.value === preference.value)?.label
      ?? t('settings.general.langSystem'),
  );

  const handleSelectLanguage = (value: LocalePreference) => {
    isLanguageOpen.value = false;
    setPreference(value);
  };

  // 执行环境：后端 NONE 表示未设置，语义上不同于沙箱，界面显示「未知」而非兜底成沙箱
  const executionEnvValue = computed<'LOCAL' | 'SAND_BOX' | 'UNKNOWN'>(() => {
    const type = userConfig.envType;
    if (type === 'LOCAL') return 'LOCAL';
    if (type === 'SAND_BOX') return 'SAND_BOX';
    return 'UNKNOWN';
  });
  const executionEnv = computed<string>(() => {
    if (executionEnvValue.value === 'LOCAL') return t('settings.general.envLocal');
    if (executionEnvValue.value === 'SAND_BOX') return t('settings.general.envSandbox');
    return t('settings.general.envUnknown');
  });
  const isExecutionEnvOpen = ref(false);
  const executionEnvOptions = computed<{ value: 'LOCAL' | 'SAND_BOX'; label: string }[]>(() => [
    { value: 'LOCAL', label: t('settings.general.envLocal') },
    { value: 'SAND_BOX', label: t('settings.general.envSandbox') },
  ]);

  // 1. 工作空间权限 (对应 UserConfigVO.accessMode)
  const accessMode = computed<AgentAccessMode>(() => userConfig.accessMode);
  const isAccessModeOpen = ref(false);
  const accessModeOptions = computed<{ label: string; value: AgentAccessMode; desc: string }[]>(() => [
    { label: t('settings.general.accessInWorkspace'), value: 'IN_WORKSPACE', desc: t('settings.general.accessInWorkspaceDesc') },
    { label: t('settings.general.accessReadOnly'), value: 'READ_ONLY_IN_WORKSPACE', desc: t('settings.general.accessReadOnlyDesc') },
    { label: t('settings.general.accessFull'), value: 'OUT_OF_WORKSPACE', desc: t('settings.general.accessFullDesc') },
  ]);

  // 2. 工具权限 (对应 UserConfigVO.commandApprovalPolicy)
  const commandApprovalPolicy = computed<CommandApprovalPolicyType>(
    () => userConfig.commandApprovalPolicy ?? 'DANGEROUS_BLOCK',
  );
  const isCommandApprovalPolicyOpen = ref(false);
  const commandApprovalPolicyOptions = computed<{ label: string; value: CommandApprovalPolicyType; desc: string }[]>(() => [
    { label: t('settings.general.policyDangerBlock'), value: 'DANGEROUS_BLOCK', desc: t('settings.general.policyDangerBlockDesc') },
    { label: t('settings.general.policyPreConfirm'), value: 'PRE_EXEC_CONFIRM', desc: t('settings.general.policyPreConfirmDesc') },
    { label: t('settings.general.policyFullAccess'), value: 'FULL_ACCESS', desc: t('settings.general.policyFullAccessDesc') },
  ]);

  const currentAccessModeLabel = computed(() => {
    return accessModeOptions.value.find(o => o.value === accessMode.value)?.label
      ?? t('settings.general.accessInWorkspace');
  });

  const currentCommandApprovalPolicyLabel = computed(() => {
    return commandApprovalPolicyOptions.value.find(o => o.value === commandApprovalPolicy.value)?.label
      ?? t('settings.general.policyDangerBlock');
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

    const handleSelectExecutionEnv = async (value: 'LOCAL' | 'SAND_BOX') => {
    isExecutionEnvOpen.value = false;
    const type: WorkspaceEnvType = value;
    // 后端入参用 code（sandbox/local）而非枚举名，WorkspaceType.fromCode 按 code 解析
    const ok = await userConfig.patch('envType', type, { type: type === 'LOCAL' ? 'local' : 'sandbox' });
    if (ok) emit('modelUpdated');
  };

  const handleSelectAccessMode = async (opt: AgentAccessMode) => {
    isAccessModeOpen.value = false;
    await userConfig.patch('accessMode', opt, { accessMode: opt });
  };

  const handleSelectCommandApprovalPolicy = async (opt: CommandApprovalPolicyType) => {
    isCommandApprovalPolicyOpen.value = false;
    await userConfig.patch('commandApprovalPolicy', opt, { commandApprovalPolicy: opt });
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
    if (mode === 'system') {
      // 跟随系统：解析出当前系统主题落到内存与库里。
      // 这样下次打开仍是确定的一个值，不会因为系统主题变了而与库里记录对不上。
      localStorage.removeItem(THEME_STORAGE_KEY);
      mode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    setTheme(mode);
    const persisted = mode === 'dark' ? 'DARK' : 'LIGHT';
    void userConfig.patch('renderTheme', persisted, { renderTheme: persisted });
  };

  onMounted(async () => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      themeMode.value = saved;
    } else {
      themeMode.value = 'system';
    }

    // 配置真值统一由 store 载入；本页只负责把已载入的 renderTheme 同步到运行时主题。
    if (await userConfig.load()) {
      const remote = userConfig.renderTheme === 'DARK' ? 'dark' : 'light';
      // 本地显式选过就尊重本地（首屏已经按它渲染过了），否则采纳服务端偏好
      if (!saved) {
        setTheme(remote);
        themeMode.value = remote;
      }
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
    isLanguageOpen,
    languageOptions,
    currentLanguageLabel,
    handleSelectLanguage,
    executionEnv,
    executionEnvValue,
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
