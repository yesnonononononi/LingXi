export interface ChatCommand {
  input: string;
  sessionId?: number | string | null;
  workDir: string,
  modelId: number,
  workspaceId: number,
  /* 直接指定单个 Agent 聊天时的 Agent ID；团队模式无需传（由编排器取指挥者）。 */
  agentId: number,
  requirePlan: boolean,
  image?: File,
  imageUrl?: string
}