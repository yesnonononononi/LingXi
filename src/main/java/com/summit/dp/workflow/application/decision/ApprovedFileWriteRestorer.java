package com.summit.dp.workflow.application.decision;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workflow.infrastructure.tools.file.FileMutationTools;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * 文件改动审批重建：按 {@code content.kind=FILE_WRITE} 快照还原那次越界写入。
 *
 * <p>只关心「快照 → 可执行的调用」，不关心审批状态机（登记 / 两段式事务 / 恢复）。</p>
 */
@Component
@RequiredArgsConstructor
public class ApprovedFileWriteRestorer {

    private final ObjectMapper objectMapper;
    private final ApprovalWorkspaceResolver workspaces;
    private final ObjectProvider<ToolRegistry> toolRegistry;

    /**
     * 重建审批通过时待执行的文件改动调用；环境或参数与快照不一致即抛 {@link ClientException}。
     *
     * <p><b>为什么要在这次调用上临时抬档</b>：口径 A 的语义是「用户点批准 = 对这一次越界改动
     * 知情同意」。工具执行器按 {@code attributes} 里的档位决定走 {@code resolve} 还是
     * {@code resolveInside}，因此这次调用必须带上完全访问档，否则批了照样被目录围栏拦住。
     * 抬档只作用于本次重建出的 {@link ToolExecution}，<b>不写回执行自己的 attributes</b> ——
     * 后续轮次仍按用户选的档位跑，一次性授权不扩散。</p>
     */
    public ToolExecution restore(Execution execution, ToolCall toolCall) {
        FileWriteSnapshot snapshot = readSnapshot(toolCall);
        if (!FileMutationTools.contains(snapshot.toolName())) {
            throw new ClientException("审批工具不是写类文件工具，无法执行: " + snapshot.toolName());
        }
        ToolDefinition<?> tool = toolRegistry.getObject().getTool(snapshot.toolName());
        if (tool == null) {
            throw new ClientException("审批的文件工具已不可用: " + snapshot.toolName());
        }
        Workspace workspace = workspaces.resolve(execution);
        if (!Objects.equals(snapshot.workspaceId(), workspace.id())
                || !Objects.equals(snapshot.workDir(), workspace.workDir())) {
            throw new ClientException("文件改动环境已变化，请重新发起审批");
        }
        // 参数与卡片展示的路径必须一致：两个表示之间被改动过，说明这份快照不可信。
        if (!Objects.equals(snapshot.path(), readArgsPath(snapshot.args()))) {
            throw new ClientException("文件改动审批参数不一致");
        }
        // 仍然越界才算同一次审批；已经落回工作区内说明环境变了，不能拿旧卡去放行。
        if (isInsideWorkspace(workspace, snapshot.path())) {
            throw new ClientException("文件改动环境已变化，请重新发起审批");
        }
        return ToolExecution.builder()
                .id(toolCall.getId())
                .executionId(execution.getId())
                .responseId(execution.getLastResponseId())
                .toolDefinition(tool)
                .args(snapshot.args())
                .workspace(workspace)
                .attributes(elevatedAttributes(execution))
                .eventMetaData(execution.eventMetaData())
                .build();
    }

    /** 本次调用带完全访问档；原 attributes 可能不可变，一律复制后再改。 */
    private Map<String, Object> elevatedAttributes(Execution execution) {
        Map<String, Object> source = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Map<String, Object> elevated = source == null ? new HashMap<>() : new HashMap<>(source);
        elevated.put(AgentAccessMode.ATTRIBUTE_KEY, AgentAccessMode.OUT_OF_WORKSPACE.name());
        return elevated;
    }

    /** 与执行器同一处边界判定：{@code resolveInside} 能解析成功就说明已经不在工作区外。 */
    private boolean isInsideWorkspace(Workspace workspace, String path) {
        try {
            workspace.resolveInside(path);
            return true;
        } catch (OutWorkSpaceException outside) {
            return false;
        }
    }

    private String readArgsPath(String args) {
        if (args == null || args.isBlank()) {
            return null;
        }
        try {
            JsonNode node = objectMapper.readTree(args);
            return node != null && node.hasNonNull(ToolCallKeys.PATH)
                    ? node.get(ToolCallKeys.PATH).asText() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 从 {@code content}（{@code kind=FILE_WRITE}）解出重建所需的载荷。 */
    private FileWriteSnapshot readSnapshot(ToolCall toolCall) {
        JsonNode node;
        try {
            node = toolCall.getContent() == null || toolCall.getContent().isBlank()
                    ? null : objectMapper.readTree(toolCall.getContent());
        } catch (Exception e) {
            node = null;
        }
        if (node == null) {
            throw new ClientException("文件改动审批快照不存在");
        }
        return new FileWriteSnapshot(field(node, ToolCallKeys.PATH), field(node, ToolCallKeys.WORK_DIR),
                field(node, ToolCallKeys.WORKSPACE_ID), field(node, ToolCallKeys.ARGS),
                toolCall.getToolName());
    }

    private static String field(JsonNode node, String name) {
        return node != null && node.hasNonNull(name) ? node.get(name).asText() : null;
    }

    /** 文件改动审批快照（来自 {@code tool_call.content}，{@code kind=FILE_WRITE}）。 */
    private record FileWriteSnapshot(String path, String workDir, String workspaceId, String args,
                                     String toolName) {
    }
}
