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
import com.summit.dp.tools.baseTools.arguments.ChoiceQuestionArgument;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

/** 提问先登记准备槽位，避免执行尚未退出就接受回答。 */
@RequiredArgsConstructor
@Component
public class RequireChoiceToolExecutor implements ToolExecutor {

    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;
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
            return ToolExecuteResult.promise("Waiting for the user.");
        } catch (Exception e) {
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}
