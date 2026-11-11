package com.summit.dp.session.application.service;

import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 删掉「一个会话」及其全部附属数据，独立一个短事务。
 *
 * <p><b>为什么按单个会话切事务</b>：整棵树打包成一个事务时，事务要覆盖消息、轮次、任务、清单、
 * 审计、卡片、执行、上下文、图片九类存储的批量删除；会话越大持锁越久，删一个几百轮的历史会话
 * 就能把库卡住。按会话各开一个短事务后，单次锁窗口只覆盖一个会话的数据量，中途失败也能从
 * 剩下的会话继续。</p>
 *
 * <p><b>为什么独立成类</b>：事务边界只有走代理的公开方法才生效。编排方
 * （{@link SessionAggregateService}）循环调用本类，才不会被自调用绕过代理。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SessionNodeDeletion {

    private final SessionRepository sessions;
    private final SessionDataPurger purger;

    /**
     * 删掉一个会话行及其附属数据。
     *
     * <p>行先删：后面每一步都在给「这个会话」收尾，行还在就还有展示位。
     * 两者同事务，不存在「行删了、数据没删」的中间态。</p>
     *
     * @param sessionId 会话 id（子会话或根会话）
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void deleteNode(Long sessionId) {
        List<Long> ids = List.of(sessionId);
        sessions.deleteByIds(ids);
        purger.purge(ids);
        log.info("删除会话: sessionId={}", sessionId);
    }
}
