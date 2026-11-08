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
        view.setLiveTotalTokens(liveTotal);
        view.setLiveMaxTokens(liveMax);
        view.setLiveRatio(session == null ? null : session.getContextRatio());
        view.setRemainingTokens(liveTotal == null || liveMax == null ? null : liveMax - liveTotal);
        // 剩余比例只由框架已用比例换算，不再从计数反推。
        Double liveRatio = view.getLiveRatio();
        view.setRemainingRatio(liveRatio == null ? null : 1 - liveRatio);
        view.setTotalTokens(audit == null ? null : audit.getTotalTokens());
        view.setDriftTokens(audit == null ? null
                : audit.driftTokens(liveTotal == null ? null : liveTotal.longValue()));
        view.setCapturedAt(audit == null ? null : audit.getCapturedAt());
        view.setFailReason(audit == null ? null : audit.getFailReason());
        return view;
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
