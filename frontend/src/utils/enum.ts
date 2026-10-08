/**
 * 后端枚举值的规范化与判定。
 *
 * 收敛原因：后端下发的枚举存在大小写不规范、前后空格的情况，
 * 此前各页面各自 `as 强转 + trim().toUpperCase() + includes 白名单`，
 * 同一逻辑抄了 3 遍且白名单分散。
 */

/**
 * 把任意输入规范化为受信任的枚举值。
 * 匹配失败返回 fallback，绝不把非法值强转后写进状态。
 */
export function normalizeEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback?: T
): T | undefined {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toUpperCase() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

/** 会话访问范围档位 */
export const AGENT_ACCESS_MODES = ['IN_WORKSPACE', 'READ_ONLY_IN_WORKSPACE', 'OUT_OF_WORKSPACE'] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export function normalizeAccessMode(raw: unknown, fallback?: AgentAccessMode): AgentAccessMode | undefined {
  return normalizeEnum(raw, AGENT_ACCESS_MODES, fallback);
}

/** 命令审批策略 */
export const COMMAND_APPROVAL_POLICIES = ['DANGEROUS_BLOCK', 'PRE_EXEC_CONFIRM', 'FULL_ACCESS'] as const;
export type CommandApprovalPolicyType = (typeof COMMAND_APPROVAL_POLICIES)[number];

export function normalizeCommandApprovalPolicy(
  raw: unknown,
  fallback?: CommandApprovalPolicyType
): CommandApprovalPolicyType | undefined {
  return normalizeEnum(raw, COMMAND_APPROVAL_POLICIES, fallback);
}

/** 工作空间运行环境（对齐后端 WorkspaceType 枚举名） */
export const WORKSPACE_ENV_TYPES = ['SAND_BOX', 'LOCAL', 'NONE'] as const;
export type WorkspaceEnvType = (typeof WORKSPACE_ENV_TYPES)[number];

/** 思考深度档位：对应后端 UserConfig.reasoning_effort（小写字面量） */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 归一化思考深度：后端可能下发大写或带空格，识别不了回落缺省 low */
export function normalizeReasoningEffort(raw: unknown, fallback?: ReasoningEffort): ReasoningEffort | undefined {
  if (typeof raw !== 'string') return fallback;
  return normalizeEnum(raw.trim().toLowerCase(), REASONING_EFFORTS, fallback);
}

/**
 * 归一化工作空间类型。
 *
 * 契约来源：docs/frontend-backend-contract.md §5。
 * 后端 `WorkspaceType` **无 `@JsonValue`**、全局未配 `WRITE_ENUMS_USING_TO_STRING`，
 * Jackson 按 `name()` 输出枚举名 —— 取值为 **`SAND_BOX` / `LOCAL` / `NONE`**（非小写 `sandbox`）。
 * 该字段来自 `UserConfigVO.type`（`WorkspaceVO` 里根本没有 `type`）。
 *
 * 解析宽容度：`WorkspaceType.fromCode` 大小写不敏感，接受 `sandbox`/`sand_box`/`local`，
 * 故保留宽容解析；但识别不了时返回 **`null`**（不再兜底 `sandbox`）——
 * 「未知」与「沙箱」语义不同，兜底会误导用户对安全边界的判断。
 */
export function normalizeWorkspaceEnvType(raw: unknown): 'SAND_BOX' | 'LOCAL' | 'NONE' | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/_/g, '');
  if (normalized === 'sandbox') return 'SAND_BOX';
  if (normalized === 'local') return 'LOCAL';
  if (normalized === 'none') return 'NONE';
  return null;
}

/** 设置弹窗 Tab */
export const SETTINGS_TABS = ['general', 'models', 'agents', 'mcp', 'teams', 'data', 'terms', 'about'] as const;
export type SettingsTabKey = (typeof SETTINGS_TABS)[number];

export function normalizeSettingsTab(raw: unknown, fallback: SettingsTabKey = 'general'): SettingsTabKey {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase() as SettingsTabKey;
  return SETTINGS_TABS.includes(normalized) ? normalized : fallback;
}

/* ------------------------------------------------------------------ */
/* 计划状态                                                             */
/* ------------------------------------------------------------------ */

/** 计划书已被用户批准 */
const PLAN_APPROVED_STATUSES = ['APPROVED'] as const;

export function isPlanApproved(status?: string | null): boolean {
  if (!status) return false;
  const normalized = status.trim().toUpperCase();
  return (PLAN_APPROVED_STATUSES as readonly string[]).includes(normalized);
}

