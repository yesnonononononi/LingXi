package com.summit.dp.toolcall.application.service;

import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.event.ToolCallPendingEvent;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 命令审批登记器：把「一条待审批命令」落成唯一权威的 {@code tool_call} 卡片（{@code type=PROMISE}，
 * {@code content.kind=COMMAND}），并推送统一卡片事件。
 *
 * <p><b>为什么独立成类：</b>原先这段业务编排（读命令载荷 → 登记 PROMISE → 发 SSE 事件）内联在
 * {@code CommandPolicyConfig}（{@code @Configuration}）里，配置类被迫承担业务逻辑、且无法脱离
 * Spring 上下文测试（评审 P1-④）。抽出后配置类只做装配，本组件负责编排。</p>
 */
@Service
@RequiredArgsConstructor
public class CommandApprovalRegistrar {

    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;
    private final ToolCallEventPublisher events;
    private final ExecutionIdentity identity;

    /**
     * 把待审批命令登记为一条 {@code PROMISE} 卡片（唯一权威源），并推送统一卡片事件。
     *
     * @param execution 本次命令执行的框架上下文（提供 tool_call/execution 标识与工作空间）
     * @param command   待审批的原始命令文本
     * @param shell     命令将要运行的目标 shell（写入卡片载荷，供前端展示）
     */
    public void register(ToolExecution execution, String command, ShellType shell) {
        long sessionId = ExecutionIdentity.sessionId(execution);
        long executionId = Long.parseLong(execution.getExecutionId());
        String toolCallId = execution.getId();
        String toolName = execution.getToolDefinition().name();
        String workspaceId = execution.getWorkspace().id();
        String workDir = execution.getWorkspace().workDir();

        registrar.registerPromise(ToolCallRegisterCommand.promise(
                toolCallId, sessionId, executionId, toolName, ToolCallKind.COMMAND, "命令审批",
                converter.commandContent(command, workDir, shell.name(), workspaceId, execution.getArgs()),
                converter.rawInput(execution.getArgs())));

        long rootSessionId = identity.rootSessionIdOfSession(sessionId);
        events.publish(rootSessionId,
                ToolCallPendingEvent.of(rootSessionId, toolCallId, ToolCallKind.COMMAND.name(),
                        String.valueOf(sessionId), String.valueOf(executionId)));
    }
}
