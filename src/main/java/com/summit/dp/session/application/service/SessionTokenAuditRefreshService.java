package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.convert.TokenAuditConverter;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.application.port.SessionTokenAuditSource;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** 手动审计独立于快照查询，避免终态事件监听器反向依赖框架工具注册表。 */
@Service
@RequiredArgsConstructor
public class SessionTokenAuditRefreshService {
    private final SessionRepository sessionRepository;
    private final SessionTokenAuditSource auditSource;
    private final TokenAuditConverter converter;
    private final SessionTokenAuditRepository auditRepository;
    private final SessionTokenAuditQueryService queryService;

    public Result<SessionTokenAuditVO> refresh(Long sessionId) {
        throwIf(sessionId == null, "会话ID不能为空");
        sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        SessionTokenAuditSource.Snapshot snapshot = auditSource.refresh(sessionId).orElse(null);
        throwIf(snapshot == null, "当前会话还没有可用于重新审计的执行检查点");

        TokenAuditReconciler.Result measured =
                TokenAuditReconciler.reconcile(converter.measureCheckpoint(snapshot.document(), snapshot.usage()));
        SessionTokenAudit audit = SessionTokenAudit.capture(sessionId, snapshot.executionId(), measured,
                snapshot.capturedAt(), snapshot.usage() != null);
        audit.changeFrameworkDocument(TokenAuditFrameworkViewConverter.write(snapshot.document()));
        auditRepository.replaceSnapshot(audit);

        // 返回已提交的快照；并发时仓储可能保留了更新的一份。
        return queryService.find(sessionId);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
