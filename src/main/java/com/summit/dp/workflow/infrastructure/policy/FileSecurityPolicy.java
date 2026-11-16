package com.summit.dp.workflow.infrastructure.policy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.sandbox_security.application.FileRuleMatcher;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.Map;

/**
 * 「文件安全」规则的执行侧接线：把文件工具调用翻译成「路径 + 读/写/删」，再交给规则裁决。
 *
 * <p>存在意义：规则的消费者曾经是沙箱策略（旧的 MxcSecurityPolicy 收 denied 路径清单），
 * 换到 Windows 原生沙箱后规格里没有清单入参，规则表一度变成只存不用的摆设。
 * 这里补回消费者，让界面上那三条描述真的生效。</p>
 */
@Component
@RequiredArgsConstructor
public class FileSecurityPolicy implements ToolExecutionPolicy {

    private final ObjectMapper objectMapper;
    private final FileRuleMatcher matcher;

    /** 工具名 → 该工具对文件做了什么。只登记路径型文件工具，其它工具一律不参与。 */
    private static final Map<String, FileRuleMatcher.Operation> OPERATIONS = Map.of(
            ToolCatalog.READ_FILE, FileRuleMatcher.Operation.READ,
            ToolCatalog.SEARCH_FILES, FileRuleMatcher.Operation.READ,
            ToolCatalog.READ_IMAGE, FileRuleMatcher.Operation.READ,
            ToolCatalog.WRITE_FILE, FileRuleMatcher.Operation.WRITE,
            ToolCatalog.EDIT_FILE, FileRuleMatcher.Operation.WRITE,
            ToolCatalog.DELETE_FILE, FileRuleMatcher.Operation.DELETE);

    /**
     * 必须早于 {@code FileWriteApprovalPolicy}（-800）：被规则禁止的路径不该先弹一张越界审批卡，
     * 让用户以为「点批准就能写」。
     */
    @Override
    public int order() {
        return -820;
    }

    @Override
    public ToolExecuteResult beforeExecution(ToolExecution execution) {
        if (execution == null || execution.getToolDefinition() == null) {
            return null;
        }
        String toolName = execution.getToolDefinition().name() == null
                ? null : execution.getToolDefinition().name().trim();
        FileRuleMatcher.Operation operation = OPERATIONS.get(toolName);
        if (operation == null) {
            return null;
        }
        String path = readPath(execution.getArgs());
        if (path == null || path.isBlank()) {
            // 参数缺失不属于规则范围：交给执行器按自己的参数校验报错。
            return null;
        }
        Path target = resolveTarget(execution, path);
        if (target == null) {
            return null;
        }
        SecurityDecision decision = matcher.evaluate(target, operation,
                AgentPermissionMode.from(execution.getAttributes()));
        return decision == null ? null : ToolExecuteResult.err(decision.describeFile(path));
    }

    /**
     * 按工作区解析目标路径。
     *
     * <p>用 {@code resolve} 而不是 {@code resolveInside}：被规则保护的多半是工作区外的隐私目录，
     * 越界本身由越界审批管，这里只关心「落在哪条规则的范围里」。</p>
     */
    private Path resolveTarget(ToolExecution execution, String path) {
        if (execution.getWorkspace() == null) {
            return null;
        }
        try {
            return execution.getWorkspace().resolve(path).toAbsolutePath().normalize();
        } catch (RuntimeException unusable) {
            // 路径非法（含空字符等）：交给执行器报错，不在策略层猜它算哪条规则。
            return null;
        }
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
}
