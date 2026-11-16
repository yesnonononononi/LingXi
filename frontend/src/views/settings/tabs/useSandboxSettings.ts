import {computed, ref} from 'vue';
import {useUserConfigStore} from '../../../stores/userConfigStore';
import type {
    AgentPermissionMode,
    WorkspaceEnvType,
} from '../../../types/chat';
import {useI18n} from '../../../i18n';
import {
  isAccessModeMismatch,
  resolveAccessImpactKey,
  resolveSandboxState,
  type SandboxState,
} from '../../../utils/accessModePresentation';

/** 沙箱开关的三态：沿用展示真源，不在两处各定义一套。 */
export type {SandboxState} from '../../../utils/accessModePresentation';

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
  const sandboxState = computed<SandboxState>(() => resolveSandboxState(userConfig.envType));
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

  // 会话权限：统一控制命令审批与工作区访问边界（Plan 模式下由后端自动切入只读审阅）
  const permissionMode = computed<AgentPermissionMode>(() => userConfig.permissionMode);
  const permissionModeOptions = computed<{ label: string; value: AgentPermissionMode; desc: string }[]>(() => [
    { label: t('settings.general.permissionApprovalRequired'), value: 'APPROVAL_REQUIRED', desc: t('settings.general.permissionApprovalRequiredDesc') },
    { label: t('settings.general.permissionDelegatedApproval'), value: 'DELEGATED_APPROVAL', desc: t('settings.general.permissionDelegatedApprovalDesc') },
    { label: t('settings.general.permissionFull'), value: 'FULL_ACCESS', desc: t('settings.general.permissionFullDesc') },
  ]);
  const currentPermissionModeLabel = computed(() => permissionModeOptions.value.find(o => o.value === permissionMode.value)?.label
    ?? t('settings.general.permissionApprovalRequired'));

  /**
   * 档位与执行环境必须一起读：同一个档位在本地与沙箱下能写到哪儿并不相同。
   */
  const permissionModeImpact = computed<{ warn: boolean; text: string }>(() => {
    const state = sandboxState.value;
    const prefix = state === 'UNSET' ? t('settings.general.impactUnset') : '';
    return {
      warn: isAccessModeMismatch(permissionMode.value, state),
      text: prefix + t(resolveAccessImpactKey(permissionMode.value, state)),
    };
  });

  const handleSelectPermissionMode = async (opt: AgentPermissionMode): Promise<void> => {
    await userConfig.patch('permissionMode', opt, { permissionMode: opt });
  };

  return {
    sandboxState,
    envLabel,
    isSavingEnv,
    setSandboxEnabled,
    permissionMode,
    permissionModeOptions,
    currentPermissionModeLabel,
    permissionModeImpact,
    handleSelectPermissionMode,
  };
}
