package com.summit.dp.tools.baseTools.require_choice;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.event.ToolCallPendingEvent;
import com.summit.dp.tools.baseTools.arguments.ChoiceQuestionArgument;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

/**
 * 向用户提问：登记一条 {@code PROMISE} 工具调用（{@code kind=CHOICE}），推送统一卡片事件，
 * 返回 PROMISE 后由框架提交工具结果并结束本轮。
 *
 * <p>卡片载荷（问题 + 候选选项）写入 {@code tool_call.content}，是唯一权威源；
 * 工具结果只留一句中性说明，不描述提问内容、也不预告「即将收到回答」。</p>
 */
@RequiredArgsConstructor
@Component
public class RequireChoiceToolExecutor implements ToolExecutor {

    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;
    private final ToolCallEventPublisher toolCallEventPublisher;
    private final ExecutionIdentity executionIdentity;
    private final ObjectMapper mapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution execution) {
        try {
            ChoiceQuestionArgument args = mapper.readValue(execution.getArgs(), ChoiceQuestionArgument.class);
            long executionId = Long.parseLong(execution.getExecutionId());
            long sessionId = ExecutionIdentity.sessionId(execution);
            String toolCallId = execution.getId();

            registrar.registerPromise(ToolCallRegisterCommand.promise(
                    toolCallId, sessionId, executionId, "require_choice", ToolCallKind.CHOICE,
                    args.getQuestion(),
                    converter.choiceContent(args.getQuestion(), args.getOptions()),
                    converter.rawInput(execution.getArgs())));

            // 按根会话定向推送（子会话执行时提问卡片也必须归入父任务的流）。
            long rootSessionId = executionIdentity.rootSessionIdOfSession(sessionId);
            toolCallEventPublisher.publish(rootSessionId,
                    ToolCallPendingEvent.of(rootSessionId, toolCallId, ToolCallKind.CHOICE.name(),
                            String.valueOf(sessionId), String.valueOf(executionId)));
            return ToolExecuteResult.promise("Waiting for the user.");
        } catch (Exception e) {
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}
