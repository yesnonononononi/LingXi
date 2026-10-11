package com.summit.dp.toolcall.application.service.impl;

import com.summit.dp.execution.application.port.ExecutionLock;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Optional;

/** 收口使用独立事务，避免执行已提交后仍依赖原事务写入。 */
@Service
@RequiredArgsConstructor
public class ToolCallServiceImpl implements ToolCallService {
    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final TransactionTemplate transactions;
    private final ExecutionLock executionLock;

    @Override
    public Optional<ToolCallVO> findById(String toolCallId) {
        if (toolCallId == null || toolCallId.isBlank()) return Optional.empty();
        return toolCallRepository.findById(toolCallId).map(converter::toVO);
    }

    @Override
    public List<ToolCallVO> listByConversationId(Long conversationId) {
        if (conversationId == null) return List.of();
        return toolCallRepository.listByConversationId(conversationId).stream().map(converter::toVO).toList();
    }

    @Override
    public void cancelPendingToolCalls(String executionId) {
        Long id = parseExecutionId(executionId);
        if (id == null) return;
        synchronized (executionLock.monitor(executionId)) {
            TransactionTemplate closure = new TransactionTemplate(transactions.getTransactionManager());
            closure.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            closure.executeWithoutResult(status -> {
                for (ToolCall toolCall : toolCallRepository.listUnresolvedByExecutionId(id)) {
                    if (toolCall.complete(converter.cancelled("执行已结束，未完成互动已收口"))) {
                        toolCallRepository.updateById(toolCall);
                    }
                }
            });
        }
    }

    private static Long parseExecutionId(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return Long.valueOf(raw.trim());
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
