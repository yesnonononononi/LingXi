package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditDisplayState;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import com.summit.dp.shared.vo.TokenAuditRequestOverheadVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** 组合框架审计快照与实时用量，展示分项不再按业务父级重新归一。 */
@Service
@RequiredArgsConstructor
public class SessionTokenAuditQueryService {
    private final SessionTokenAuditRepository auditRepository;
    private final SessionRepository sessionRepository;

    public Result<SessionTokenAuditVO> find(Long sessionId) {
        throwIf(sessionId == null, "会话ID不能为空");
        Session session = sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        return Result.success(build(sessionId, session));
    }

    public SessionTokenAuditVO snapshot(Long sessionId) {
        throwIf(sessionId == null, "会话ID不能为空");
        return build(sessionId, sessionRepository.findById(sessionId).orElse(null));
    }

    private SessionTokenAuditVO build(Long sessionId, Session session) {
        SessionTokenAudit audit = auditRepository.findBySessionId(sessionId).orElse(null);
        Integer liveTotal = resolveLiveTokens(session);
        Integer liveMax = session == null ? null : session.getContextMaxTokens();
        SessionTokenAuditVO view = TokenAuditFrameworkViewConverter.read(
                audit == null ? null : audit.getFrameworkDocument());
        view.setSessionId(sessionId);
        view.setDisplayState(audit == null ? TokenAuditDisplayState.NOT_COLLECTED.name()
                : audit.resolveDisplayState(liveTotal == null ? null : liveTotal.longValue()).name());
        TokenAuditFrameworkViewConverter.applyLiveUsage(
                view, liveTotal, liveMax, session == null ? null : session.getContextRatio());
        applyOverhead(view, audit, audit != null && audit.getFrameworkDocument() != null);
        view.setTotalTokens(audit == null ? null : audit.getTotalTokens());
        view.setDriftTokens(audit == null ? null
                : audit.driftTokens(liveTotal == null ? null : liveTotal.longValue()));
        view.setCapturedAt(audit == null ? null : audit.getCapturedAt());
        view.setFailReason(audit == null ? null : audit.getFailReason());
        return view;
    }

    /**
     * 补上「其他消息」的父项金额、父项比例与框架残差。
     *
     * <p>框架文档只给出工具定义子项，父项（{@code total − Σ messages}）与残差是业务侧口径，
     * 必须在这里补：否则前端只能显示一个「N 项」徽标，消息构成永远合不上。</p>
     *
     * <p>比例用<b>快照当时的上限</b>（{@code audit.maxTokens}）做分母 —— 与框架分项 ratio 同源；
     * 用实时上限会让父项和子项分母不一致（模型切换后尤其明显）。</p>
     *
     * <p>两种情况必须区分：</p>
     * <ol>
     *   <li><b>有框架原文、两个子项都审计失败</b>：框架不给 {@code requestOverhead}，
     *       但父项金额仍是已知事实，要新建对象下发，整块不能因此消失；</li>
     *   <li><b>没有框架原文</b>（历史快照）：连分项都没有，单独一个父项金额无法闭合、
     *       只会误导，按原样不下发。</li>
     * </ol>
     */
    private static void applyOverhead(SessionTokenAuditVO view, SessionTokenAudit audit, boolean hasDocument) {
        Integer tokens = audit == null ? null : audit.getRequestOverheadTokens();
        TokenAuditRequestOverheadVO overhead = view.getRequestOverhead();
        if (overhead == null) {
            if (!hasDocument || tokens == null) return;
            overhead = TokenAuditRequestOverheadVO.builder().build();
            view.setRequestOverhead(overhead);
        }
        overhead.setTokens(tokens);
        Integer max = audit == null ? null : audit.getMaxTokens();
        overhead.setRatio(tokens == null || max == null || max <= 0 ? null : (double) tokens / max);
        overhead.setFramingResidualTokens(audit == null ? null : audit.framingResidualTokens());
    }

    private static Integer resolveLiveTokens(Session session) {
        if (session == null || session.getContextTokenCount() == null) return null;
        long tokens = session.getContextTokenCount();
        if (tokens < 0) return null;
        return tokens > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) tokens;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
