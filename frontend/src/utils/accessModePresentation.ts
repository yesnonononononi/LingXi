import type {AgentAccessMode, WorkspaceEnvType} from '../types/chat';

/**
 * 访问档位的展示真源：档位语义**依赖执行环境**，两处（安全中心、输入区徽标）必须读同一份判断。
 *
 * <p>关键事实：本地执行环境不走沙箱构建，终端没有任何目录围栏；沙箱下 `IN_WORKSPACE` 在 Windows
 * 也是整盘普通目录可写。所以「只读」「普通修改」这两个词单独出现都会骗人，必须带环境后缀。</p>
 */

/** 执行环境三态：后端 NONE 表示未设置，不能折叠成「已关闭」。 */
export type SandboxState = 'ON' | 'OFF' | 'UNSET';

/** 档位在文案键里的短名。 */
export type AccessPreset = 'ReadOnly' | 'InWorkspace' | 'Full';

export function resolveSandboxState(envType?: WorkspaceEnvType | string | null): SandboxState {
  if (envType === 'SAND_BOX') return 'ON';
  if (envType === 'LOCAL') return 'OFF';
  return 'UNSET';
}

export function resolveAccessPreset(mode?: AgentAccessMode | string | null): AccessPreset {
  if (mode === 'READ_ONLY_IN_WORKSPACE') return 'ReadOnly';
  if (mode === 'OUT_OF_WORKSPACE') return 'Full';
  return 'InWorkspace';
}

/**
 * 本地/未设置环境下的只读档只是「文件工具被禁用」，终端照样能写，必须显式警示。
 * 这是三档里唯一会让人误以为「已经被保护住」的组合。
 */
export function isAccessModeMismatch(mode: AgentAccessMode | string | null | undefined, state: SandboxState): boolean {
  return state !== 'ON' && resolveAccessPreset(mode) === 'ReadOnly';
}

/** 安全中心「实际效果」说明的文案键。 */
export function resolveAccessImpactKey(mode: AgentAccessMode | string | null | undefined, state: SandboxState): string {
  return `settings.general.impact${resolveAccessPreset(mode)}${state === 'ON' ? 'Sandbox' : 'Local'}`;
}

/** 输入区徽标的悬停说明：必须同时带上档位与环境。 */
export function resolveAccessTipKey(mode: AgentAccessMode | string | null | undefined, state: SandboxState): string {
  return `chat.input.accessModeTip${resolveAccessPreset(mode)}${state === 'ON' ? 'Sandbox' : 'Local'}`;
}

/** 输入区徽标的短标签。 */
export function resolveAccessBadgeKey(mode: AgentAccessMode | string | null | undefined): string {
  return `chat.input.accessModeBadge${resolveAccessPreset(mode)}`;
}
