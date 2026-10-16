import { computed, onMounted, ref } from 'vue';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import { SandboxAPI } from '../../../services/sandbox';
import type {
  AgentAccessMode,
  CommandApprovalPolicyType,
  SandboxServiceStatus,
  WorkspaceEnvType,
} from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useI18n } from '../../../i18n';

/** 沙箱开关的三态：NONE 是「后端未设置」，不能渲染成「已关闭」——那是另一种事实。 */
export type SandboxState = 'ON' | 'OFF' | 'UNSET';

/**
 * 安全中心的沙箱级设置：执行环境、沙箱服务能力检查、工作空间权限、工具权限。
 *
 * <p>这四项原先挂在「通用设置」里，但语义都是沙箱隔离策略，因此随安全中心一起走；
 * 通用页只保留主题、语言与服务地址。</p>
 *
 * <p>patch 的 key 一律是 store 字段名（如 `envType`），后端字段名不一致时由 payload
 * 单独给出 —— 两者混用会出现「键值对不上」的静默 bug。</p>
 *
 * @param emitModelUpdated 执行环境变化后通知外层刷新模型
 */
export function useSandboxSettings(emitModelUpdated: () => void) {
  const userConfig = useUserConfigStore();
  const { t } = useI18n();

  // 执行环境：后端 NONE 表示未设置，语义上不同于沙箱，界面显示「未知」而非兜底成沙箱
  const sandboxState = computed<SandboxState>(() => {
    if (userConfig.envType === 'SAND_BOX') return 'ON';
    if (userConfig.envType === 'LOCAL') return 'OFF';
    return 'UNSET';
  });
  const envLabel = computed<string>(() => {
    if (sandboxState.value === 'ON') return t('settings.general.envSandbox');
    if (sandboxState.value === 'OFF') return t('settings.general.envLocal');
    return t('settings.general.envUnknown');
  });
  const isSavingEnv = ref(false);

  const setSandboxEnabled = async (enabled: boolean): Promise<void> => {
    if (isSavingEnv.value) return;
    const type: WorkspaceEnvType = enabled ? 'SAND_BOX' : 'LOCAL';
    isSavingEnv.value = true;
    // 后端入参用 code（sandbox/local）而非枚举名，WorkspaceType.fromCode 按 code 解析
    const ok = await userConfig.patch('envType', type, { type: enabled ? 'sandbox' : 'local' });
    isSavingEnv.value = false;
    if (ok) emitModelUpdated();
  };

  // 状态查询不执行命令，基础能力检查由用户显式发起
  const sandboxStatus = ref<SandboxServiceStatus | null>(null);
  const isCheckingSandbox = ref(false);
  const sandboxError = ref('');
  const sandboxNotice = ref('');

  const loadSandboxStatus = async (): Promise<void> => {
    try {
      const res = await SandboxAPI.status();
      sandboxStatus.value = isOk(res.code) ? (res.data ?? null) : null;
    } catch {
      sandboxStatus.value = null;
    }
  };

  const checkSandboxService = async (): Promise<void> => {
    if (isCheckingSandbox.value) return;
    isCheckingSandbox.value = true;
    sandboxError.value = '';
    sandboxNotice.value = '';
    try {
      const res = await SandboxAPI.check();
      if (isOk(res.code)) {
        sandboxNotice.value = res.data?.message || t('settings.general.sandboxChecked');
        sandboxStatus.value = res.data ?? null;
      } else {
        // 详细运行诊断仅写入后端日志。
        sandboxError.value = res.errMsg || t('settings.general.sandboxCheckFailed');
      }
    } catch (error) {
      sandboxError.value = error instanceof Error && error.message
        ? error.message
        : t('settings.general.sandboxCheckFailed');
    } finally {
      isCheckingSandbox.value = false;
    }
  };

  // 工作空间权限：文件表的粗粒度默认策略，规则命中前先生效
  const accessMode = computed<AgentAccessMode>(() => userConfig.accessMode);
  const accessModeOptions = computed<{ label: string; value: AgentAccessMode; desc: string }[]>(() => [
    { label: t('settings.general.accessInWorkspace'), value: 'IN_WORKSPACE', desc: t('settings.general.accessInWorkspaceDesc') },
    { label: t('settings.general.accessReadOnly'), value: 'READ_ONLY_IN_WORKSPACE', desc: t('settings.general.accessReadOnlyDesc') },
    { label: t('settings.general.accessFull'), value: 'OUT_OF_WORKSPACE', desc: t('settings.general.accessFullDesc') },
  ]);
  const currentAccessModeLabel = computed(() => accessModeOptions.value.find(o => o.value === accessMode.value)?.label
    ?? t('settings.general.accessInWorkspace'));

  const handleSelectAccessMode = async (opt: AgentAccessMode): Promise<void> => {
    await userConfig.patch('accessMode', opt, { accessMode: opt });
  };

  // 工具权限：命令表未命中时沿用的通用命令权限
  const commandApprovalPolicy = computed<CommandApprovalPolicyType>(
    () => userConfig.commandApprovalPolicy ?? 'DANGEROUS_BLOCK',
  );
  const commandApprovalPolicyOptions = computed<{ label: string; value: CommandApprovalPolicyType; desc: string }[]>(() => [
    { label: t('settings.general.policyDangerBlock'), value: 'DANGEROUS_BLOCK', desc: t('settings.general.policyDangerBlockDesc') },
    { label: t('settings.general.policyPreConfirm'), value: 'PRE_EXEC_CONFIRM', desc: t('settings.general.policyPreConfirmDesc') },
    { label: t('settings.general.policyFullAccess'), value: 'FULL_ACCESS', desc: t('settings.general.policyFullAccessDesc') },
  ]);
  const currentCommandApprovalPolicyLabel = computed(() => commandApprovalPolicyOptions.value
    .find(o => o.value === commandApprovalPolicy.value)?.label ?? t('settings.general.policyDangerBlock'));

  const handleSelectCommandApprovalPolicy = async (opt: CommandApprovalPolicyType): Promise<void> => {
    await userConfig.patch('commandApprovalPolicy', opt, { commandApprovalPolicy: opt });
  };

  onMounted(() => {
    // 与规则表无关，先发出去别挡首屏渲染。
    void loadSandboxStatus();
  });

  return {
    sandboxState,
    envLabel,
    isSavingEnv,
    setSandboxEnabled,
    sandboxStatus,
    isCheckingSandbox,
    sandboxError,
    sandboxNotice,
    checkSandboxService,
    accessMode,
    accessModeOptions,
    currentAccessModeLabel,
    handleSelectAccessMode,
    commandApprovalPolicy,
    commandApprovalPolicyOptions,
    currentCommandApprovalPolicyLabel,
    handleSelectCommandApprovalPolicy,
  };
}
