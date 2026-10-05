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
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 会话消息读路径查询服务：把「单条纯转换」与「一次批量装载工具调用」<b>显式串联在一个方法</b>内，
 * 杜绝只调转换、漏装载导致卡片静默丢失（评审 P1-③，推荐改法 b）。
 *
 * <p><b>单页 {@code tool_call} 查询恒为 1 次（设计 §7.1）：</b>先遍历本页 TOOL 行、从
 * {@code content}（即 {@code call_id}）收集去重集合，再一次性批量查回，最后挂到各自的 VO 上。
 * 缺行 / JSON 解析失败一律降级（{@code toolCall} 为 {@code null}），消息不丢、不抛异常。</p>
 *
 * <p>转换本身由 {@link SessionMessageViewAssembler}（纯内存、无仓储）承担；本类只做「编排 + 一次 IO」，
 * 因此持久化依赖从「转换器」上移到了应用服务层。</p>
 */
@Service
@RequiredArgsConstructor
public class SessionMessageQueryService {

    private final SessionMessageViewAssembler viewAssembler;
    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter toolCallConverter;
    private final SessionMessageRepositoryImpl sessionMessageRepositoryImpl;

    /**
     * 转换 + 一次批量装载工具调用。
     *
     * @param slice 本页存储态消息（可为 {@code null}）
     * @return 本页视图 {@link SessionMessageVO} 列表 + 命中（成功挂载 {@code toolCall}）的 TOOL 行数
     */
    public SessionMessageQueryResult query(List<SessionMessage> slice) {
        List<SessionMessageVO> records = new ArrayList<>();
        if (slice != null) {
            for (SessionMessage message : slice) {
                records.add(viewAssembler.toVO(message));
            }
        }
        int toolCallCount = attachToolCalls(records);
        return new SessionMessageQueryResult(records, toolCallCount);
    }

    /**
     * 批量挂载工具调用：一次 {@code IN} 查询（去重集合为空则跳过）。
     *
     * @return 命中（成功挂载 {@code toolCall}）的 TOOL 行数，用于 {@code SessionMessagePageVO.toolCallCount}
     */
    private int attachToolCalls(List<SessionMessageVO> records) {
        if (records == null || records.isEmpty()) {
            return 0;
        }
        Set<String> ids = new LinkedHashSet<>();
        for (SessionMessageVO vo : records) {
            if (isToolRow(vo) && vo.getToolCallId() != null && !vo.getToolCallId().isBlank()) {
                ids.add(vo.getToolCallId());
            }
        }
        if (ids.isEmpty()) {
            return 0;
        }
        Map<String, ToolCallVO> byId = toolCallRepository.listByIds(ids).stream()
                .collect(Collectors.toMap(ToolCall::getId, toolCallConverter::toVO,
                        (first, second) -> first));
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
