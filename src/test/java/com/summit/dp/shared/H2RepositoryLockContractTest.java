package com.summit.dp.shared;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailPO;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.*;

/** 仓储承诺锁定读时，其他连接必须等到持锁事务提交后才能修改同一行。 */
class H2RepositoryLockContractTest {
    enum Target { SESSION_STATE, SESSION_APPEND, MAILBOX, MAIL_DEDUP }

    @ParameterizedTest
    @EnumSource(Target.class)
    void lockedReadPreventsAnotherTransactionFromUpdatingTheSameRow(Target target) throws Exception {
        try (H2TestDatabase database = H2TestDatabase.create("repository-lock-" + target)) {
            SqlSessionTemplate sql = H2TestDatabase.sqlSession(database.sessionFactory(
                    SessionMapper.class, SessionMessageMapper.class, EmailMapper.class, EmailMessageMapper.class));
            SessionMapper sessions = sql.getMapper(SessionMapper.class);
            EmailMapper mailboxes = sql.getMapper(EmailMapper.class);
            EmailMessageMapper messages = sql.getMapper(EmailMessageMapper.class);
            sessions.insert(SessionPO.builder().id(7L).name("行锁测试").build());
            mailboxes.insert(EmailPO.builder().id(10L).workflowExecutionId(900L).recipientAgentId(7L).status(1).build());
            messages.insert(EmailMessagePO.builder().id(11L).emailId(10L).senderId(1L)
                    .dedupKey("lock-key").content("正文").status("PENDING").build());
            Runnable lock = switch (target) {
                case SESSION_STATE -> () -> new SessionRepositoryImpl(sessions).lockById(7L).orElseThrow();
                case SESSION_APPEND -> () -> new SessionMessageRepositoryImpl(sql.getMapper(SessionMessageMapper.class),
                        sessions).lockSessionForAppend(7L);
                case MAILBOX -> () -> new EmailRepositoryImpl(mailboxes).findByBusinessKeyForUpdate(900L, 7L).orElseThrow();
                case MAIL_DEDUP -> () -> new EmailMessageRepositoryImpl(messages).findByDedupKeyForUpdate("lock-key").orElseThrow();
            };
            Runnable update = switch (target) {
                case SESSION_STATE, SESSION_APPEND -> () -> assertEquals(1, sessions.update(null,
                        new LambdaUpdateWrapper<SessionPO>().eq(SessionPO::getId, 7L).set(SessionPO::getName, "更新")));
                case MAILBOX -> () -> assertEquals(1, mailboxes.update(null,
                        new LambdaUpdateWrapper<EmailPO>().eq(EmailPO::getId, 10L).set(EmailPO::getStatus, 2)));
                case MAIL_DEDUP -> () -> assertEquals(1, messages.update(null,
                        new LambdaUpdateWrapper<EmailMessagePO>().eq(EmailMessagePO::getId, 11L)
                                .set(EmailMessagePO::getStatus, "CONSUMED")));
            };
            TransactionTemplate transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
            CountDownLatch locked = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            CountDownLatch updating = new CountDownLatch(1);
            try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
                Future<?> holder = pool.submit(() -> transactions.executeWithoutResult(status -> {
                    lock.run();
                    locked.countDown();
                    await(release);
                }));
                Future<?> contender;
                try {
                    assertTrue(locked.await(10, TimeUnit.SECONDS));
                    contender = pool.submit(() -> transactions.executeWithoutResult(status -> {
                        updating.countDown();
                        update.run();
                    }));
                    assertTrue(updating.await(10, TimeUnit.SECONDS));
                    assertThrows(TimeoutException.class, () -> contender.get(200, TimeUnit.MILLISECONDS));
                } finally {
                    release.countDown();
                }
                holder.get(10, TimeUnit.SECONDS);
                contender.get(10, TimeUnit.SECONDS);
            }
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(15, TimeUnit.SECONDS), "持锁事务等待超时");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("持锁事务被中断", interrupted);
        }
    }
}
