package com.summit.dp.toolcall.application.service.impl;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Objects;

/**
 * 审批命令重建：按 {@code content.kind=COMMAND} 快照把待执行的命令还原成 {@link ToolExecution}。
 *
 * <p>从 {@link CommandApprovalExecutor} 拆出的「重建」职责：它只关心「快照 → 可执行的调用」，
 * 不关心审批状态机（登记 / 两段式事务 / 恢复）。拆开后两侧可独立演进——审批编排改状态机时
 * 不必重读环境校验，环境校验收紧时也不必重读编排。</p>
 *
 * <p><b>沿用既有安全约束（防「审批期间环境被替换后重放」）</b>：审批工具必须仍是注册表里的
 * 命令工具；工作空间 id / workDir / shell 三者任一变化都拒绝执行；批准的命令与快照中的命令
 * 不一致也拒绝——命令绝不带着过期上下文落地。</p>
 */
@Component
@RequiredArgsConstructor
public class ApprovedCommandRestorer {

    private final ObjectMapper objectMapper;
    private final WorkspaceManager workspaces;
    private final ObjectProvider<ToolRegistry> toolRegistry;

    /** 重建审批通过时待执行的命令调用；环境或参数与快照不一致即抛 {@link ClientException}。 */
    public ToolExecution restore(Execution execution, ToolCall toolCall) {
        CommandSnapshot snapshot = readCommandSnapshot(toolCall);
        ToolDefinition<?> tool = toolRegistry.getObject().getTool(snapshot.toolName());
        if (tool == null || !(tool.executor() instanceof CommandToolDefinitionExecutor)) {
            throw new ClientException("审批命令工具不可用");
        }
        Workspace workspace = workspaces.acquire(execution.getAgentRequest().getWorkspaceSpec());
        if (!Objects.equals(snapshot.workspaceId(), workspace.id())
                || !Objects.equals(snapshot.workDir(), workspace.workDir())
                || !Objects.equals(snapshot.shell(), workspace.runtimeEnvironment().shellType().name())) {
            throw new ClientException("命令执行环境已变化，请重新发起审批");
        }
        String args = snapshot.args();
        try {
            if (!Objects.equals(snapshot.command(),
                    objectMapper.readValue(args, ExecuteCommandRequest.class).getCommand())) {
                throw new ClientException("命令审批参数不一致");
            }
        } catch (JsonProcessingException e) {
            throw new ClientException("命令审批参数无效");
        }
        // 工具槽位全部落定前不会再次调用模型，审批沿用暂停时的响应身份。
        return ToolExecution.builder()
                .id(toolCall.getId())
                .executionId(execution.getId())
                .responseId(execution.getLastResponseId())
                .toolDefinition(tool)
                .args(args)
                .workspace(workspace)
                .attributes(execution.getAgentRequest().runtimeParametersOrDefault().getAttributes())
                .eventMetaData(execution.eventMetaData())
                .build();
    }

    /** 从 {@code content}（{@code kind=COMMAND}）解出重建 {@link ToolExecution} 所需的载荷。 */
    private CommandSnapshot readCommandSnapshot(ToolCall toolCall) {
        JsonNode node = parse(toolCall.getContent());
        if (node == null) {
            throw new ClientException("命令审批快照不存在");
        }
        return new CommandSnapshot(field(node, ToolCallKeys.COMMAND), field(node, ToolCallKeys.WORK_DIR),
                field(node, ToolCallKeys.SHELL), field(node, ToolCallKeys.WORKSPACE_ID),
                field(node, ToolCallKeys.ARGS), toolCall.getToolName());
    }

    private JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static String field(JsonNode node, String name) {
        return node != null && node.hasNonNull(name) ? node.get(name).asText() : null;
    }

    /** 命令审批快照（来自 {@code tool_call.content}，{@code kind=COMMAND}）。 */
    private record CommandSnapshot(String command, String workDir, String shell, String workspaceId,
                                   String args, String toolName) {
    }
}
