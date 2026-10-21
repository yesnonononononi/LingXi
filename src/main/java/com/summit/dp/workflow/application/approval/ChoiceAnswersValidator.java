package com.summit.dp.workflow.application.approval;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/** 分组依据原模型请求，不能由客户端删减或拼接待答卡片。 */
@Component
@RequiredArgsConstructor
public class ChoiceAnswersValidator {
    private final ObjectMapper mapper;
    private final MessageRepository messages;

    public void validateInput(ChoiceAnswersCommand command) {
        throwIf(command == null, "回答请求不能为空");
        throwIf(command.conversationId() == null, "回答请求缺少所属会话");
        throwIf(command.responseId() == null || command.responseId().isBlank(), "回答请求缺少问题组标识");
        throwIf(command.commandId() == null || command.commandId().isBlank(), "回答请求缺少命令标识");
        throwIf(command.answers() == null || command.answers().isEmpty(), "请填写全部问题后提交");
        Set<String> ids = new HashSet<>();
        for (ChoiceAnswersCommand.Answer answer : command.answers()) {
            throwIf(answer == null || answer.toolCallId() == null || answer.toolCallId().isBlank(), "回答缺少工具调用标识");
            throwIf(!ids.add(answer.toolCallId()), "同一问题不能重复提交");
            throwIf(answer.expectedVersion() == null, "回答缺少卡片版本，请刷新后重试");
            throwIf(answer.text() == null || answer.text().isBlank(), "请填写全部问题后提交");
        }
    }

    public void validateOwnership(ChoiceAnswersCommand command, List<ToolCall> cards) {
        Long executionId = cards.getFirst().getExecutionId();
        throwIf(executionId == null, "问题卡片缺少所属执行");
        for (ToolCall card : cards) {
            throwIf(!Objects.equals(command.conversationId(), card.getConversationId())
                    || !Objects.equals(executionId, card.getExecutionId())
                    || !ToolCatalog.REQUIRE_CHOICE.equals(card.getToolName()), "只能一起提交同一执行的选择问题");
        }
    }

    public Set<String> groupCallIds(ChoiceAnswersCommand command, Execution execution) {
        throwIf(execution.getMessages() == null, "找不到原问题组，不能提交回答");
        SessionMessage row = messages.findByResponseId(command.conversationId(), command.responseId())
                .orElseThrow(() -> new ClientException("找不到原问题组，不能提交回答"));
        throwIf(row.getType() != SessionMessageType.AI, "问题组没有对应的模型响应");
        AiMessageEntity response;
        try {
            response = mapper.readValue(row.getText(), AiMessageEntity.class);
        } catch (JsonProcessingException error) {
            throw new ClientException("原问题组内容无法解析，请刷新后重试");
        }
        throwIf(response.getToolCalls() == null, "原问题组没有工具调用");
        Set<String> ids = new HashSet<>();
        response.getToolCalls().stream().filter(call -> ToolCatalog.REQUIRE_CHOICE.equals(call.name()))
                .forEach(call -> ids.add(call.id()));
        throwIf(ids.isEmpty(), "原模型响应中没有选择问题");
        throwIf(execution.getMessages().stream().filter(message -> message instanceof AiMessageEntity)
                .map(message -> (AiMessageEntity) message).noneMatch(message -> message.getToolCalls() != null
                        && message.getToolCalls().stream().map(call -> call.id()).collect(Collectors.toSet()).containsAll(ids)),
                "原问题组不属于当前执行上下文");
        return ids;
    }

    public String digest(ChoiceAnswersCommand command) {
        List<ChoiceAnswersCommand.Answer> sorted = command.answers().stream()
                .sorted(Comparator.comparing(ChoiceAnswersCommand.Answer::toolCallId)).toList();
        try {
            return CommandDigest.build(mapper.writeValueAsString(new ChoiceAnswersCommand(
                    command.conversationId(), command.responseId(), command.commandId(), sorted)));
        } catch (JsonProcessingException error) {
            throw new ClientException("无法解析回答请求，请重新提交");
        }
    }

    private void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }
}
