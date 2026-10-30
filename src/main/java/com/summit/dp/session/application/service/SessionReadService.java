package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.SessionExecutionStateChanged;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import lombok.RequiredArgsConstructor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/** 已读与状态迁移共用行锁，广播版本跟随会话递增。 */
@Service
@RequiredArgsConstructor
public class SessionReadService {
    private final SessionRepository repository;
    private final SessionService sessionService;
    private final ApplicationEventPublisher events;

    @Transactional
    public Result<SessionVO> read(Long sessionId, Long expectedVersion) {
        throwIf(sessionId == null, "会话ID不能为空");

        // 单语句条件更新取代「先锁行再改」：未读且版本匹配才置已读。
        // SQLite 只有一个写者，事务里「先读后升写」在竞争时不会排队（升写失败立刻返回 SQLITE_BUSY），
        // 把条件写放在事务的第一条语句，既保留了「不覆盖别人的新版本」，也不再需要行锁。
        if (repository.markReadIfUnread(sessionId, expectedVersion)) {
            events.publishEvent(new SessionStateChanged(sessionService.findById(sessionId).getData()));
        }

        return sessionService.findById(sessionId);
    }

    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    public void onExecutionStateChanged(SessionExecutionStateChanged event) {
        // 会话可在执行途中删除，渲染投影不能阻止剩余检查点收尾。
        repository.lockById(event.sessionId()).ifPresent(session -> changeRead(session, false));
    }

    private void changeRead(Session session, boolean read) {
        session.changeRead(read);
        repository.updateRead(session);

        events.publishEvent(new SessionStateChanged(sessionService.findById(session.getId()).getData()));
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
