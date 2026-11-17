package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import lombok.RequiredArgsConstructor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 会话置顶/取消置顶。
 *
 * <p>与 {@link SessionReadService} 同构：状态迁移 + 提交后广播，因此独立成类，不塞进会话应用服务。</p>
 */
@Service
@RequiredArgsConstructor
public class SessionPinService {
    private final SessionRepository repository;
    private final SessionService sessionService;
    private final ApplicationEventPublisher events;

    /**
     * 设置置顶状态。幂等：目标态与当前态一致时只回读，不写库也不广播。
     *
     * @param sessionId 根会话 id
     * @param pinned    目标状态
     * @return 更新后的会话视图（前端据此拿权威 version，不必自己猜）
     */
    @Transactional
    public Result<SessionVO> setPinned(Long sessionId, boolean pinned) {
        throwIf(sessionId == null, "会话ID不能为空");
        Session session = repository.findById(sessionId).orElseThrow(SessionNoFoundException::new);
        // 子会话在二级树里跟随父会话：单独 pin 一个子会话是没人能看见的状态，拒绝而不是静默接受。
        throwIf(session.isSubSession(), "子会话跟随所属根会话置顶，不能单独设置");

        if (session.isPinned() != pinned && repository.updatePinned(sessionId, pinned)) {
            events.publishEvent(new SessionStateChanged(sessionService.findById(sessionId).getData()));
        }
        return sessionService.findById(sessionId);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
