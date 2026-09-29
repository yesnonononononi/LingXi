package com.summit.dp.toolcall.application.service.impl;

import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * 唯一登记器实现：{@code tool_call} 表的唯一写入入口（幂等 UPSERT，最后写入者胜出）。
 *
 * <p><b>为什么不在本类注入 {@code ExecutionControl} / {@code IChatAgent}：</b>本类被
 * {@code CreatePlanTool} 依赖，若注入上述重量级 bean 会形成
 * {@code IChatAgent → createPlanTool → registrar → executionControl → IChatAgent} 的构造期闭环。
 * 会话 id 通过 {@link ExecutionIdentity} 的纯仓储回查获得，无构造期依赖环。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallRegistrarImpl implements ToolCallRegistrar {

    private static final String LOG_PREFIX = "【tool-call-registrar】";

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ExecutionIdentity executionIdentity;

    @Override
    @Transactional
    public String registerPromise(ToolCallRegisterCommand cmd) {
        if (cmd == null || cmd.toolCallId() == null || cmd.toolCallId().isBlank()) {
            throw new IllegalArgumentException("toolCallId is required to register a promise");
        }
        ToolCall existing = toolCallRepository.findById(cmd.toolCallId()).orElse(null);
        if (existing == null) {
            ToolCall created = ToolCall.builder()
                    .id(cmd.toolCallId())
                    .conversationId(cmd.conversationId())
                    .executionId(cmd.executionId())
                    .toolName(cmd.toolName())
                    .type(ToolCallType.PROMISE)
                    .status(ToolCallStatus.PENDING)
                    .title(cmd.title())
                    .content(cmd.content())
                    .rawInput(cmd.rawInput())
                    .metaData(converter.executionMeta(cmd.executionId(), cmd.toolName()))
                    .createdAt(Instant.now())
                    .updatedAt(Instant.now())
                    .build();
            toolCallRepository.save(created);
        } else {
            // 命中已有行（可能是 EXECUTE 占位）→ 升级为 PROMISE/pending，最后写入者胜出。
            existing.promoteToPromise(ToolCallType.PROMISE, cmd.toolName(), cmd.title(), cmd.content(), cmd.rawInput());
            toolCallRepository.updateById(existing);
        }
        return cmd.toolCallId();
    }

    @Override
    @Transactional
    public void markExecuteStarted(String toolCallId, long executionId, String toolName, String argsJson) {
        if (toolCallId == null || toolCallId.isBlank()) {
            return;
        }
        if (toolCallRepository.existsById(toolCallId)) {
            return;   // 已存在（含 PROMISE 升级行）→ no-op
        }
        Long conversationId = resolveConversationId(executionId);
        if (conversationId == null) {
            log.warn("{} markExecuteStarted 无法定位会话，跳过: toolCallId={}, executionId={}",
                    LOG_PREFIX, toolCallId, executionId);
            return;
        }
        ToolCall started = ToolCall.builder()
                .id(toolCallId)
                .conversationId(conversationId)
                .executionId(executionId)
                .toolName(toolName)
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.IN_PROGRESS)
                .rawInput(converter.rawInput(argsJson))
                .metaData(converter.executionMeta(executionId, toolName))
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
        toolCallRepository.save(started);
    }

    @Override
    @Transactional
    public void completeExecute(String toolCallId, long executionId, String toolName, String argsJson,
                                String output, ToolCallOutcome outcome) {
        if (toolCallId == null || toolCallId.isBlank()) {
            return;
        }
        String rawOutput = converter.executeOutcome(outcome, output);
        ToolCall existing = toolCallRepository.findById(toolCallId).orElse(null);
        if (existing == null) {
            // 兜底：无占位行（如框架 REJECTED/超时且未发 START）时补一条 completed。
            Long conversationId = resolveConversationId(executionId);
            if (conversationId == null) {
                log.warn("{} completeExecute 无法定位会话，跳过: toolCallId={}, executionId={}",
                        LOG_PREFIX, toolCallId, executionId);
                return;
            }
            ToolCall fallback = ToolCall.builder()
                    .id(toolCallId)
                    .conversationId(conversationId)
                    .executionId(executionId)
                    .toolName(toolName)
                    .type(ToolCallType.EXECUTE)
                    .status(ToolCallStatus.COMPLETED)
                    .rawInput(converter.rawInput(argsJson))
                    .rawOutput(rawOutput)
                    .metaData(converter.executionMeta(executionId, toolName))
                    .createdAt(Instant.now())
                    .updatedAt(Instant.now())
                    .build();
            toolCallRepository.save(fallback);
            return;
        }
        if (existing.getType() == ToolCallType.PROMISE) {
            return;   // PROMISE 的结论交给 decide 端点收尾
        }
        if (existing.isCompleted()) {
            return;   // 终态幂等
        }
        existing.complete(rawOutput);
        toolCallRepository.updateById(existing);
    }

    /** 纯仓储回查会话 id；解析失败返回 {@code null}（降级，不抛异常）。 */
    private Long resolveConversationId(long executionId) {
        try {
            return executionIdentity.sessionId(String.valueOf(executionId));
        } catch (RuntimeException e) {
            return null;
        }
    }
}
