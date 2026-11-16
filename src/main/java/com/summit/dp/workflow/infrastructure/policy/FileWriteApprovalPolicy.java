package com.summit.dp.workflow.infrastructure.policy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.decision.FileWriteApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.tools.file.FileMutationTools;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 越界写入审批：写类工具要改工作区外的文件时，先登记卡片再挂起等待用户批准。
 *
 * <p>边界判定复用执行器那条 {@code resolveInside} —— 两边各写一套判据时，会出现
 * 「策略认为越界、执行器认为没越界」这种批了也跑不通的卡片。反过来，工作区内的改动
 * 一律直通，不打扰用户。</p>
 */
@Component
@RequiredArgsConstructor
public class FileWriteApprovalPolicy implements ToolExecutionPolicy {

    private final ObjectMapper objectMapper;
    private final FileWriteApprovalRegistrar approvalRegistrar;

    /**
     * 越界判定与命令审批互不相干，但仍要给出自己的次序：
     * 并列时先后只取决于 Spring 的注入顺序，不可依赖。
     */
    @Override
    public int order() {
        return -800;
    }

    @Override
    public ToolExecuteResult beforeExecution(ToolExecution execution) {
        if (execution.getToolDefinition() == null
                || !FileMutationTools.contains(execution.getToolDefinition().name())) {
            return null;
        }
        // 完全访问档就是用户的明确授权，无需逐次批准。
        if (AgentPermissionMode.from(execution.getAttributes()).allowsOutsideWorkspace()) {
            return null;
        }
        String path = readPath(execution.getArgs());
        if (path == null || path.isBlank()) {
            // 参数缺失不属于审批范围：交给执行器按自己的参数校验报错。
            return null;
        }
        Workspace workspace = execution.getWorkspace();
        if (workspace == null) {
            return ToolExecuteResult.err("文件改动环境不可用，无法发起审批");
        }
        if (!isOutsideWorkspace(workspace, path)) {
            return null;
        }
        approvalRegistrar.register(execution, path);
        return ToolExecuteResult.promise("文件改动尚未执行，正在等待用户批准：" + path);
    }

    private String readPath(String args) {
        if (args == null || args.isBlank()) {
            return null;
        }
        try {
            JsonNode node = objectMapper.readTree(args);
            return node != null && node.hasNonNull(ToolCallKeys.PATH)
                    ? node.get(ToolCallKeys.PATH).asText() : null;
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** 与执行器同一处边界判定：解析不出工作区内的路径即为越界。 */
    private boolean isOutsideWorkspace(Workspace workspace, String path) {
        try {
            workspace.resolveInside(path);
            return false;
        } catch (OutWorkSpaceException outside) {
            return true;
        } catch (RuntimeException unusable) {
            // 路径本身非法（含空字符等）：交给执行器报错，不在策略层猜它算不算越界。
            return false;
        }
    }
}
