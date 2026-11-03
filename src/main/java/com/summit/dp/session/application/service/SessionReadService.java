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

        // 通过条件更新维护已读状态，避免旧读取覆盖并发到达的新消息。
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
