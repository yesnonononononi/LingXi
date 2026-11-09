package com.summit.dp.session.application.service;

import com.summit.core.compact.ContextUsageMetric;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.application.port.SessionTokenAuditSource;
import com.summit.dp.session.domain.model.TokenAuditDisplayState;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.Instant;

/** 手动审计独立于快照查询，避免终态事件监听器反向依赖框架工具注册表。 */
@Service
@RequiredArgsConstructor
public class SessionTokenAuditRefreshService {
    private final SessionRepository sessionRepository;
    private final SessionTokenAuditSource auditSource;

    public Result<SessionTokenAuditVO> refresh(Long sessionId) {
        throwIf(sessionId == null, "会话ID不能为空");
        sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        SessionTokenAuditSource.Snapshot snapshot = auditSource.refresh(sessionId).orElse(null);
        throwIf(snapshot == null, "当前会话还没有可用于重新审计的执行检查点");

        // 总量和明细必须来自同一检查点，避免把上一轮的会话投影混进本次结果。
        SessionTokenAuditVO view = TokenAuditFrameworkViewConverter.toView(snapshot.document());
        view.setSessionId(sessionId);
        view.setDisplayState(TokenAuditDisplayState.COLLECTED.name());
        view.setCapturedAt(Instant.now());
        ContextUsageMetric usage = snapshot.usage();
        if (usage != null) {
            TokenAuditFrameworkViewConverter.applyLiveUsage(view, usage.tokenCount(), usage.maxTokens(), usage.ratio());
            view.setTotalTokens(usage.tokenCount());
        }
        return Result.success(view);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
