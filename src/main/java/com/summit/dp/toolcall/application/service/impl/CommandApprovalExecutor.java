package com.summit.dp.toolcall.application.service.impl;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolCallStatus;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * 命令（{@code COMMAND}）审批执行器：从 {@link ToolCallServiceImpl} 中拆出的「有外部副作用」分支
 * （评审 P1-① 第一刀）。
 *
 * <p><b>崩溃安全不可省（两段式）：</b>命令执行有外部副作用，故拆为两段事务——
 * T1 先把 {@code tool_call} 落 {@code in_progress}、执行落 {@code RUNNING} 并提交，**提交先于副作用**；
 * T2 再把命令输出写回执行末条 toolcall 与 {@code tool_call} 行。若合并为单事务，
 * 崩溃后「未提交但副作用已发生」会静默重放命令，故不合并。</p>
 *
 * <p>拆出后 {@link ToolCallServiceImpl} 只保留编排入口 / 归属校验 / 幂等判定 / SSE 建流，
 * 本类独占命令执行上下文（工作空间校验、{@link ToolExecution} 重建、loop 恢复）。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CommandApprovalExecutor {

    private static final String LOG_PREFIX = "【command-approval】";

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;
    private final ModelContextService modelContextService;
    private final RuntimeEventPublisher runtimeEvents;
    private final WorkspaceManager workspaces;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final ObjectProvider<ToolRegistry> toolRegistry;
    private final SessionAttributeRestorer sessionAttributeRestorer;

    /**
     * 落定一条 {@code COMMAND} 审批：两段式执行（T1 提交先于副作用）+ 异步收尾，返回承载恢复事件流的 emitter。
     *
     * @param toolCall 已确认为「可审批」状态的命令卡片
     * @param approved 是否批准（拒绝则只收尾、不执行命令）
     * @param text     用户答复原文（命令分支当前不使用，保留签名一致性）
     */
    public SseEmitter decide(ToolCall toolCall, boolean approved, String text) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        ExecutionControlSignal signal = repository.register(executionId);
        SseEmitter emitter = null;
        try {
            Execution execution = repository.findById(executionId)
                    .orElseThrow(() -> new ClientException("执行不存在: " + executionId));
            if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
                throw new ClientException("执行尚未暂停或已结束");
            }
            ToolCall current = toolCallRepository.findById(toolCall.getId())
                    .orElseThrow(() -> new ClientException("工具调用不存在: " + toolCall.getId()));
            if (!current.isApprovalPending()) {
                throw new ClientException("该审批已处理");
            }
            CommandSnapshot snapshot = readCommandSnapshot(current);
            ToolMessageEntity message = findResult(execution, current.getId(), current.getToolName());
            ToolExecution call = approved ? restoreCall(execution, snapshot, current.getId()) : null;

            emitter = sseEventPublisher.connect(executionIdentity.rootSessionIdOfSession(conversationId));
            // 事务 T1（提交先于副作用）：先落 RUNNING，崩溃不会静默重放命令。
            transactions.executeWithoutResult(status -> {
                current.markInProgress();
                execution.resume();
                repository.save(execution);
                toolCallRepository.updateById(current);
            });
            SseEmitter connected = emitter;
            CompletableFuture.runAsync(() -> finish(current, execution, message, call, signal, connected));
            return emitter;
        } catch (RuntimeException e) {
            try {
                repository.unregister(signal);
            } catch (RuntimeException cleanupFailure) {
                e.addSuppressed(cleanupFailure);
            }
            if (emitter != null) {
                emitter.completeWithError(e);
            }
            throw e;
        }
    }

    /** 命令审批异步收尾：执行副作用（若有）→ 事务 T2 落结果 → 触发循环恢复。 */
    private void finish(ToolCall toolCall, Execution execution, ToolMessageEntity message,
                        ToolExecution call, ExecutionControlSignal signal, SseEmitter emitter) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = execution.getId();
        boolean released = false;
        try {
            ToolExecuteResult result;
            ToolCallOutcome outcome;
            String rawOutput;
            if (signal.isCancelRequired()) {
                result = ToolExecuteResult.err("命令未执行：执行已取消");
                outcome = ToolCallOutcome.CANCELLED;
                rawOutput = converter.cancelled("执行已取消");
            } else if (call == null) {
                result = ToolExecuteResult.err("用户拒绝，命令未执行");
                outcome = ToolCallOutcome.REJECTED;
                rawOutput = converter.commandOutcome(ToolCallOutcome.REJECTED, null, "用户拒绝，命令未执行");
            } else {
                runtimeEvents.onToolCall(new ToolCallStartEvent(call.getId(), execution.getId(),
                        call.getToolDefinition().name(), call.getArgs()));
                result = call.getToolDefinition().executor().execute(call);
                outcome = ToolCallOutcome.APPROVED;
                rawOutput = converter.commandOutcome(ToolCallOutcome.APPROVED, result.getToolOutput(), null);
            }
            message.setText(result.getToolOutput());
            if (signal.isCancelRequired()) {
                execution.cancel();
            } else {
                execution.suspended();
            }
            ToolCallOutcome finalOutcome = outcome;
            String finalRawOutput = rawOutput;
            // 事务 T2：把命令输出写回执行末条 toolcall 与 tool_call 行，再回写上下文。
            transactions.executeWithoutResult(status -> {
                toolCall.complete(finalRawOutput);
                repository.save(execution);
                modelContextService.replace(conversationId, execution.getMessages());
                toolCallRepository.updateById(toolCall);
            });
            runtimeEvents.onToolCallOutput(new ToolCallEndEvent(String.valueOf(message.getId()), execution.getId(),
                    message.getName(), call == null ? "" : call.getArgs(), result.getToolOutput(),
                    resultStatusOf(finalOutcome, signal.isCancelRequired())));

            boolean pending = !toolCallRepository.listPendingByExecutionId(Long.valueOf(executionId)).isEmpty();
            released = true;
            repository.unregister(signal);
            Execution latest = repository.findById(executionId).orElseThrow();
            if (!pending && latest.getExecutionState() == ExecutionState.SUSPENDED) {
                // 恢复不经过 RequestPreparer：先把会话级业务属性（团队绑定）补回请求再交给 loop，
                // 否则恢复后的委派工具解析不到团队，子 Agent 起不来。
                sessionAttributeRestorer.restore(latest, conversationId);
                Execution resumed = executionControl.getObject().resume(latest);
                modelContextService.replace(conversationId, resumed.getMessages());
            }
        } catch (Exception e) {
            log.error("{} command approval failed: executionId={}", LOG_PREFIX, executionId, e);
            if (!released) {
                execution.fail("命令审批执行中断；请检查命令实际结果，禁止自动重放：" + e.getMessage());
                try {
                    repository.save(execution);
                    toolCall.complete(converter.commandOutcome(ToolCallOutcome.FAILED, null, e.getMessage()));
                    toolCallRepository.updateById(toolCall);
                } catch (Exception saveFailure) {
                    e.addSuppressed(saveFailure);
                }
            }
            runtimeEvents.onExecutionError(new ExecutionErrorEvent(e.getMessage(), "命令审批执行失败", execution.getId()));
        } finally {
            try {
                if (!released) {
                    repository.unregister(signal);
                }
            } finally {
                emitter.complete();
            }
        }
    }

    /** 定位承载该调用的 {@code ToolMessageEntity}：主键命中优先，退化为按工具名取最后一条。 */
    private static ToolMessageEntity findResult(Execution execution, String toolCallId, String toolName) {
        List<Message> messages = execution.getMessages();
        if (messages != null) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message message = messages.get(i);
                if (message instanceof ToolMessageEntity tool && toolCallId.equals(String.valueOf(tool.getId()))) {
                    return tool;
                }
            }
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message message = messages.get(i);
                if (message instanceof ToolMessageEntity tool && toolName != null && toolName.equals(tool.getName())) {
                    return tool;
                }
            }
        }
        throw new ClientException("找不到原命令的工具结果，不能执行审批");
    }

    /** 从 {@code content}（{@code kind=COMMAND}）解出重建 {@link ToolExecution} 所需的载荷。 */
    private CommandSnapshot readCommandSnapshot(ToolCall toolCall) {
        JsonNode node = converter.parse(toolCall.getContent());
        if (node == null) {
            throw new ClientException("命令审批快照不存在");
        }
        return new CommandSnapshot(field(node, ToolCallKeys.COMMAND), field(node, ToolCallKeys.WORK_DIR),
                field(node, ToolCallKeys.SHELL), field(node, ToolCallKeys.WORKSPACE_ID),
                field(node, ToolCallKeys.ARGS), toolCall.getToolName());
    }

    /**
     * 用快照重建命令调用：校验工作空间 / 命令一致性，防止审批期间环境被替换后重放。
     *
     * <p>沿用既有安全约束：工作空间 id / workDir / shell 三者任一变化都拒绝执行。</p>
     */
    private ToolExecution restoreCall(Execution execution, CommandSnapshot snapshot, String toolCallId) {
        ToolDefinition<? extends ToolExecutor> tool = toolRegistry.getObject().getTool(snapshot.toolName());
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
            if (!Objects.equals(snapshot.command(), objectMapper.readValue(args, ExecuteCommandRequest.class).getCommand())) {
                throw new ClientException("命令审批参数不一致");
            }
        } catch (JsonProcessingException e) {
            throw new ClientException("命令审批参数无效");
        }
        return ToolExecution.builder()
                .id(toolCallId)
                .executionId(execution.getId())
                .toolDefinition(tool)
                .args(args)
                .workspace(workspace)
                .attributes(execution.getAgentRequest().runtimeParametersOrDefault().getAttributes())
                .build();
    }

    /** 业务结论 → 框架结果状态（用于向外界广播工具结束事件）。 */
    private static ToolCallStatus resultStatusOf(ToolCallOutcome outcome, boolean cancelled) {
        if (cancelled) {
            return ToolCallStatus.CANCELLED;
        }
        return switch (outcome) {
            case REJECTED -> ToolCallStatus.REJECTED;
            case FAILED -> ToolCallStatus.FAILED;
            case TIMED_OUT -> ToolCallStatus.TIMED_OUT;
            default -> ToolCallStatus.COMPLETED;
        };
    }

    private static String field(JsonNode node, String name) {
        return node != null && node.hasNonNull(name) ? node.get(name).asText() : null;
    }

    /** 命令审批快照（来自 {@code tool_call.content}，{@code kind=COMMAND}）。 */
    private record CommandSnapshot(String command, String workDir, String shell, String workspaceId,
                                   String args, String toolName) {
    }
}
