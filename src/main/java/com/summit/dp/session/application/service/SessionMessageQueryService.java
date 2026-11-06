package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 会话消息读路径查询服务：把「单条纯转换」与「按给定字典挂载工具调用」<b>显式串联在一个方法</b>内，
 * 杜绝只调转换、漏挂载导致卡片静默丢失（评审 P1-③，推荐改法 b）。
 *
 * <p><b>单页 {@code tool_call} 查询恒为 1 次（设计 §7.1）：</b>这一次查询由调用方
 * （{@link TurnViewService#loadToolCalls}）统一发起 —— 同一批权威工具调用既用来挂载消息 VO，
 * 也用来装配块，两个入口共用同一份字典。本类不再自己查库，否则同一批 CLOB 会被读两遍。
 * 缺行 / JSON 解析失败一律降级（{@code toolCall} 为 {@code null}），消息不丢、不抛异常。</p>
 *
 * <p>转换本身由 {@link SessionMessageViewAssembler}（纯内存、无仓储）承担；本类只做「编排」。</p>
 */
@Service
@RequiredArgsConstructor
public class SessionMessageQueryService {

    private final SessionMessageViewAssembler viewAssembler;
    private final ToolCallConverter toolCallConverter;
    private final SessionMessageRepositoryImpl sessionMessageRepositoryImpl;

    /**
     * 转换 + 用已装载的工具调用字典挂载。
     *
     * @param slice     本页存储态消息（可为 {@code null}）
     * @param toolCalls 已装载的工具调用字典（{@code toolCallId} → 权威工具调用；可为 {@code null}）
     * @return 本页视图 {@link SessionMessageVO} 列表 + 命中（成功挂载 {@code toolCall}）的 TOOL 行数
     */
    public SessionMessageQueryResult query(List<SessionMessage> slice, Map<String, ToolCall> toolCalls) {
        List<SessionMessageVO> records = new ArrayList<>();
        if (slice != null) {
            for (SessionMessage message : slice) {
                records.add(viewAssembler.toVO(message));
            }
        }
        int toolCallCount = attachToolCalls(records, toolCalls);
        return new SessionMessageQueryResult(records, toolCallCount);
    }

    /**
     * 按给定字典挂载工具调用（不再查库）。
     *
     * @return 命中（成功挂载 {@code toolCall}）的 TOOL 行数，用于 {@code SessionMessagePageVO.toolCallCount}
     */
    private int attachToolCalls(List<SessionMessageVO> records, Map<String, ToolCall> toolCalls) {
        if (records == null || records.isEmpty() || toolCalls == null || toolCalls.isEmpty()) {
            return 0;
        }
        Map<String, ToolCallVO> byId = new LinkedHashMap<>();
        for (ToolCall toolCall : toolCalls.values()) {
            if (toolCall != null && toolCall.getId() != null) {
                byId.putIfAbsent(toolCall.getId(), toolCallConverter.toVO(toolCall));
            }
        }
        int matched = 0;
        for (SessionMessageVO vo : records) {
            if (!isToolRow(vo)) {
                continue;
            }
            ToolCallVO toolCall = vo.getToolCallId() == null ? null : byId.get(vo.getToolCallId());
            if (toolCall != null) {
                vo.setToolCall(toolCall);
                matched++;
            }
        }
        return matched;
    }

    private static boolean isToolRow(SessionMessageVO vo) {
        return vo != null && SessionMessageType.TOOL.name().equals(vo.getType());
    }

    public Result<SessionMessageVO> findByMessageId(Long messageId) {
        SessionMessage sessionMessage = sessionMessageRepositoryImpl.findById(messageId).orElse(null);
        return Result.success(sessionMessage == null ? null :viewAssembler.toVO(sessionMessage));
    }

    /** 查询结果：本页消息 VO 列表 + 命中工具调用的行数。 */
    public record SessionMessageQueryResult(List<SessionMessageVO> records, int toolCallCount) {
    }
}
