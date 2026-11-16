import type {AgentPermissionMode, WorkspaceEnvType} from '../types/chat';

/**
 * 权限档位的展示真源：档位语义**依赖执行环境**，两处（安全中心、输入区徽标）必须读同一份判断。
 *
 * <p>关键事实：只读审阅（`READ_ONLY_REVIEW`）仅在 Plan 语义下由后端自动生效，不在会话菜单中展示；
 * 可选三档为 `APPROVAL_REQUIRED`（审批模式）、`DELEGATED_APPROVAL`（代我审批）、`FULL_ACCESS`（完全访问）。</p>
 */

/** 执行环境三态：后端 NONE 表示未设置，不能折叠成「已关闭」。 */
export type SandboxState = 'ON' | 'OFF' | 'UNSET';

/** 档位在文案键里的短名。 */
export type AccessPreset = 'ApprovalRequired' | 'DelegatedApproval' | 'Full';

export function resolveSandboxState(envType?: WorkspaceEnvType | string | null): SandboxState {
  if (envType === 'SAND_BOX') return 'ON';
  if (envType === 'LOCAL') return 'OFF';
  return 'UNSET';
}

export function resolveAccessPreset(mode?: AgentPermissionMode | string | null): AccessPreset {
  if (mode === 'DELEGATED_APPROVAL') return 'DelegatedApproval';
  if (mode === 'FULL_ACCESS') return 'Full';
  return 'ApprovalRequired';
}

/** 「完全访问」也不等于终端免限：终端命令照样可能被沙箱与终端规则拦住，行右侧要常驻说明。 */
export function isFullAccessMode(mode?: AgentPermissionMode | string | null): boolean {
  return resolveAccessPreset(mode) === 'Full';
}

/**
 * 可选三档均允许在工作区内写入，不存在「以为只读其实可写」的误导组合。
 */
export function isAccessModeMismatch(
  _mode: AgentPermissionMode | string | null | undefined,
  _state: SandboxState
): boolean {
  return false;
}

/**
 * 终端是否跳出档位约束：沙箱才拦得住终端，本地/未设置环境下任何档位都管不了它。
 * 菜单标题旁的感叹号常驻，但只有按这个判据为真时才转成警示色 —— 图标不按档位判断。
 */
export function isTerminalOutsideAccessControl(state: SandboxState): boolean {
  return state !== 'ON';
}

/**
 * 标题旁感叹号的悬停说明：两个环境下「拦得住谁」正好相反，必须分开说。
 * 沙箱不拦文件读写（边界只由档位管的文件工具把着），终端命令才在沙箱里受约束。
 */
export function resolveTerminalCaveatKey(state: SandboxState): string {
  return `chat.input.accessMenuTerminalCaveat${state === 'ON' ? 'Sandbox' : 'Local'}`;
}

/** 安全中心「实际效果」说明的文案键。 */
export function resolveAccessImpactKey(mode: AgentPermissionMode | string | null | undefined, state: SandboxState): string {
  return `settings.general.impact${resolveAccessPreset(mode)}${state === 'ON' ? 'Sandbox' : 'Local'}`;
}

/**
 * 输入区上拉框的档位说明：只描述档位本身的语义，不再按环境分身。
 */
export function resolveAccessMenuDescKey(mode: AgentPermissionMode | string | null | undefined): string {
  return `chat.input.accessMenuDesc${resolveAccessPreset(mode)}`;
}

/** 输入区徽标的悬停说明：必须同时带上档位与环境。 */
export function resolveAccessTipKey(mode: AgentPermissionMode | string | null | undefined, state: SandboxState): string {
  return `chat.input.accessModeTip${resolveAccessPreset(mode)}${state === 'ON' ? 'Sandbox' : 'Local'}`;
}

/** 输入区徽标的短标签。 */
export function resolveAccessBadgeKey(mode: AgentPermissionMode | string | null | undefined): string {
  return `chat.input.accessModeBadge${resolveAccessPreset(mode)}`;
}
