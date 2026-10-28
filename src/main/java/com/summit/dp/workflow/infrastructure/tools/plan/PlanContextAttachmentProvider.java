package com.summit.dp.workflow.infrastructure.tools.plan;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.Optional;

/** 计划正文按执行读取，不混入其他模块的附件。 */
@Component
@RequiredArgsConstructor
public class PlanContextAttachmentProvider implements ContextAttachmentProvider {
    private final ToolCallRepository repository;
    private final ToolCallConverter converter;

    @Override
    public int order() { return -800; }

    @Override
    public Optional<String> attachment(Serializable executionId) {
        if (executionId == null) return Optional.empty();
        long id;
        try {
            id = Long.parseLong(executionId.toString());
        } catch (NumberFormatException failure) {
            return Optional.empty();
        }
        return repository.listByExecutionId(id).stream()
                .filter(toolCall -> toolCall.getType() == ToolCallType.PROMISE)
                .filter(toolCall -> converter.resolveKind(toolCall.getContent()) == ToolCallKind.PLAN)
                .reduce((first, second) -> second)
                .map(toolCall -> {
                    JsonNode content = converter.parse(toolCall.getContent());
                    String title = content.path(ToolCallKeys.TITLE).asText("");
                    String text = content.path(ToolCallKeys.TEXT).asText("");
                    return (title.isBlank() ? "" : "# " + title + "\n") + text;
                });
    }
}
