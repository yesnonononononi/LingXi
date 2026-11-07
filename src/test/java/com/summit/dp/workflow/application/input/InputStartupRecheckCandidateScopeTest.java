package com.summit.dp.workflow.application.input;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO;
import com.summit.dp.email.infrastructure.persistence.po.EmailPO;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.InputStartupRecheck;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;

/**
 * 启动自检的候选口径与「与历史会话数脱钩」用真实 H2 语句数证明。
 *
 * <p>断言的是<b>下发的 SQL 条数</b>而不是毫秒：机器快慢不该决定这条护栏是否变绿。候选来源既有正向
 * 用例（活跃执行 / 待消费邮件 / 未注入的终态任务各一条），也有负向用例（历史里全是「已注入的任务 +
 * 已消费的邮件」时一次唤醒都不能有）。</p>
 */
class InputStartupRecheckCandidateScopeTest {

    private static final long MAIL_AGENT_ID = 9001L;
    private static final long TURN_ID = 1L;
    /** 任务完成时刻：判「已注入」时与执行两侧的时间比较都以它为基准。 */
    private static final LocalDateTime TASK_COMPLETE_AT = LocalDateTime.of(2026, 1, 1, 0, 0, 0);
    /**
     * 先后判据用的间隔。
     *
     * <p>取一整天而不是几秒：{@code task.complete_at} 与 {@code execution.started_at / completed_at} 走的是
     * 两套类型处理器（Instant 与 LocalDateTime），落库的墙钟时刻可能相差一个时区偏移，只有「至少一天」这种
     * 量级的间隔才是与时区无关的先后见证。</p>
     */
    private static final long ORDER_GAP_HOURS = 24L;

    private Scope scope;

    @BeforeEach
    void setup() {
        scope = new Scope("InputStartupRecheckCandidateScopeTest");
    }

    @AfterEach
    void shutdown() {
        scope.close();
    }

    @Test
    @DisplayName("正向：仍活跃（CREATED / RUNNING）的执行所属会话都要被复查")
    void activeExecutionsAreCandidates() {
        long createdExecutionId = scope.insertExecution(100L, ExecutionStatusCodes.CREATED, null);
        long runningExecutionId = scope.insertExecution(200L, ExecutionStatusCodes.RUNNING, null);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(createdExecutionId);
        verify(scope.wakeups).resumeIfInputPending(runningExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    @Test
    @DisplayName("正向：挂起执行与待消费邮件都要唤醒")
    void suspendedExecutionAndPendingMailAreCandidates() {
        long suspendedExecutionId = scope.insertExecution(300L, ExecutionStatusCodes.SUSPENDED, null);
        long completedExecutionId = scope.insertExecution(400L, ExecutionStatusCodes.COMPLETED, TASK_COMPLETE_AT);
        long mailbox = scope.insertMailbox(400L, MAIL_AGENT_ID);
        scope.insertMessage(mailbox, EmailMessage.EMStatus.PENDING);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(suspendedExecutionId);
        verify(scope.wakeups).resumeIfInputPending(completedExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    @Test
    @DisplayName("正向：已完成执行 + 待消费邮件（邮件来源独立于执行状态）")
    void completedExecutionWithPendingMailIsWoken() {
        long completedExecutionId = scope.insertExecution(500L, ExecutionStatusCodes.COMPLETED, TASK_COMPLETE_AT);
        long mailbox = scope.insertMailbox(500L, MAIL_AGENT_ID);
        scope.insertMessage(mailbox, EmailMessage.EMStatus.PENDING);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(completedExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    @Test
    @DisplayName("正向：终态任务结果无人接手（之后没有执行跑完）时唤醒该会话")
    void terminalTaskWithoutLaterExecutionIsWoken() {
        long completedExecutionId = scope.insertExecution(600L, ExecutionStatusCodes.COMPLETED,
                TASK_COMPLETE_AT.minusHours(2 * ORDER_GAP_HOURS),
                TASK_COMPLETE_AT.minusHours(ORDER_GAP_HOURS));
        scope.insertTerminalTask(600L, 600L, TASK_COMPLETE_AT);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(completedExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    /**
     * 正向（必须唤醒）：任务在该轮<b>最后一次模型调用之后</b>完成，该轮随后正常结束。
     *
     * <p>执行在任务完成前就开始了（{@code started_at < task.complete_at}），却在任务完成之后才结束
     * （{@code completed_at > task.complete_at}）。这一轮之后没有再发生模型调用，结果从未被注入；
     * 旧判据 {@code completed_at >= task.complete_at} 会把它排除，导致这条结果永久不被注入。</p>
     */
    @Test
    @DisplayName("正向（漏唤醒回归）：任务在该轮最后一次模型调用之后完成，仍必须唤醒")
    void taskFinishingAfterLastModelCallStillWakes() {
        long completedExecutionId = scope.insertExecution(750L, ExecutionStatusCodes.COMPLETED,
                TASK_COMPLETE_AT.minusHours(ORDER_GAP_HOURS),
                TASK_COMPLETE_AT.plusHours(ORDER_GAP_HOURS));
        scope.insertTerminalTask(750L, 750L, TASK_COMPLETE_AT);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(completedExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    /** 负向：任务完成后该会话才新起一轮并正常完成 → 那一轮的首次模型调用必然已注入，不唤醒。 */
    @Test
    @DisplayName("负向：任务完成后新起一轮并正常完成 → 不唤醒")
    void newRoundStartedAfterTaskCompletionDoesNotWake() {
        long laterExecutionId = scope.insertExecution(760L, ExecutionStatusCodes.COMPLETED,
                TASK_COMPLETE_AT.plusHours(ORDER_GAP_HOURS),
                TASK_COMPLETE_AT.plusHours(2 * ORDER_GAP_HOURS));
        scope.insertTerminalTask(760L, 760L, TASK_COMPLETE_AT);

        scope.recheck.recheck();

        assertTrue(laterExecutionId > 0L);
        verifyNoInteractions(scope.wakeups);
        assertEquals(3, scope.capture.queries().size(),
                "没有候选时只发三条候选查询: " + scope.capture.queries());
    }

    /** 补充：任务完成后新起的执行在首次模型调用前就失败（不是 COMPLETED）→ 仍必须唤醒。 */
    @Test
    @DisplayName("补充：任务完成后新起的执行失败（首次调用前）→ 仍必须唤醒")
    void failedRoundAfterTaskCompletionStillWakes() {
        long failedExecutionId = scope.insertExecution(770L, ExecutionStatusCodes.FAILED,
                TASK_COMPLETE_AT.plusHours(ORDER_GAP_HOURS),
                TASK_COMPLETE_AT.plusHours(2 * ORDER_GAP_HOURS));
        scope.insertTerminalTask(770L, 770L, TASK_COMPLETE_AT);

        scope.recheck.recheck();

        verify(scope.wakeups).resumeIfInputPending(failedExecutionId);
        verifyNoMoreInteractions(scope.wakeups);
    }

    @Test
    @DisplayName("负向：终态任务已注入（之后有执行跑完）+ 邮件已消费 → 一次唤醒都不该有")
    void alreadyInjectedHistoryDoesNotWake() {
        long completedExecutionId = scope.insertExecution(700L, ExecutionStatusCodes.COMPLETED,
                TASK_COMPLETE_AT.plusHours(ORDER_GAP_HOURS),
                TASK_COMPLETE_AT.plusHours(2 * ORDER_GAP_HOURS));
        scope.insertTerminalTask(700L, 700L, TASK_COMPLETE_AT);
        long mailbox = scope.insertMailbox(700L, MAIL_AGENT_ID);
        scope.insertMessage(mailbox, EmailMessage.EMStatus.CONSUMED);

        scope.recheck.recheck();

        assertTrue(completedExecutionId > 0L);
        verifyNoInteractions(scope.wakeups);
        assertEquals(3, scope.capture.queries().size(),
                "没有候选时只发三条候选查询，不得为历史会话逐条解析最新执行: " + scope.capture.queries());
    }

    @Test
    @DisplayName("脱钩：50 与 500 个历史会话下，自检下发的 SQL 条数相同")
    void statementCountDoesNotGrowWithHistorySize() {
        // 两个规模各用一套隔离库，避免「上一个规模的候选」混进下一个规模的读数。
        try (Scope small = new Scope("InputStartupRecheckScopeSize50");
             Scope large = new Scope("InputStartupRecheckScopeSize500")) {
            Measure fifty = small.measure(50);
            Measure fiveHundred = large.measure(500);

            assertEquals(4, fifty.statements(),
                    "候选查询 3 条 + 一次最新执行查询，实际: " + fifty.statements());
            assertEquals(4, fiveHundred.statements(),
                    "候选查询 3 条 + 一次最新执行查询，实际: " + fiveHundred.statements());
            assertEquals(fifty.statements(), fiveHundred.statements(),
                    "历史会话从 50 涨到 500，语句条数不得增长（50=" + fifty.statements()
                            + ", 500=" + fiveHundred.statements() + "）");
            assertEquals(1, fifty.wakes(), "每个规模只允许唤醒那一个真正的候选会话");
            assertEquals(1, fiveHundred.wakes(), "历史会话再多也不得多唤醒一次");
            verify(small.wakeups, times(1)).resumeIfInputPending(anyLong());
            verifyNoMoreInteractions(small.wakeups);
            verify(large.wakeups, times(1)).resumeIfInputPending(anyLong());
            verifyNoMoreInteractions(large.wakeups);
        }
    }

    /** 一次自检的读数：下发语句条数与唤醒次数。 */
    private record Measure(int statements, int wakes) {
    }

    /**
     * 一套隔离库夹具：真实 H2 库 + 语句采集器 + 唤醒替身 + 三个仓储。
     *
     * <p>每个规模单独开库，是为了让「50」与「500」两次测量互不污染 —— 同一个库里上一次留的候选会算进
     * 下一次的读数，那就不再是「规模差异」而是「累积」。库文件落在系统临时目录，关闭即删。</p>
     */
    private static final class Scope implements AutoCloseable {

        private final H2TestDatabase database;
        private final SqlCaptureInterceptor capture;
        private final InputWakeupService wakeups;
        private final ExecutionMapper executionMapper;
        private final EmailMapper emailMapper;
        private final EmailMessageMapper emailMessageMapper;
        private final TaskMapper taskMapper;
        private final InputStartupRecheck recheck;

        private Scope(String prefix) {
            database = H2TestDatabase.create(prefix);
            capture = new SqlCaptureInterceptor();
            MybatisConfiguration configuration = database.configuration(
                    ExecutionMapper.class, EmailMapper.class, EmailMessageMapper.class, TaskMapper.class);
            configuration.addInterceptor(capture);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            SqlSessionFactory sessionFactory;
            try {
                sessionFactory = factory.getObject();
            } catch (Exception e) {
                throw new IllegalStateException("测试用 SqlSessionFactory 创建失败: " + e.getMessage(), e);
            }
            SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);
            executionMapper = template.getMapper(ExecutionMapper.class);
            emailMapper = template.getMapper(EmailMapper.class);
            emailMessageMapper = template.getMapper(EmailMessageMapper.class);
            taskMapper = template.getMapper(TaskMapper.class);
            wakeups = mock(InputWakeupService.class);
            recheck = new InputStartupRecheck(new ExecutionRepositoryImpl(executionMapper),
                    new EmailRepositoryImpl(emailMapper), new TaskRepositoryImpl(taskMapper), wakeups);
        }

        /**
         * 造 {@code historySize} 个「已完成且无输入」的历史会话（每个带一条已注入的终态任务，
         * 每 50 个再带一条已消费邮件），外加一个真正的候选会话，返回本次自检的读数。
         *
         * <p>邮件只抽样铺：候选口径里邮件来源是固定一条语句，抽样已足以证明「已消费的邮件不是候选」，
         * 而每条消息都带 CLOB，逐会话铺只会把用例拖成分钟级。</p>
         */
        private Measure measure(int historySize) {
            long offset = historySize * 1_000_000L;
            for (int index = 0; index < historySize; index++) {
                long sessionId = offset + index;
                // 历史执行：在任务完成之后才「开始」并正常完成 → 那一轮的首次模型调用已注入。
                insertExecution(sessionId, ExecutionStatusCodes.COMPLETED,
                        TASK_COMPLETE_AT.plusHours(ORDER_GAP_HOURS),
                        TASK_COMPLETE_AT.plusHours(2 * ORDER_GAP_HOURS));
                insertTerminalTask(sessionId, sessionId, TASK_COMPLETE_AT);
                if (index % 50 == 0) {
                    long mailbox = insertMailbox(sessionId, MAIL_AGENT_ID);
                    insertMessage(mailbox, EmailMessage.EMStatus.CONSUMED);
                }
            }
            long candidateExecutionId = insertExecution(offset + 999_999L, ExecutionStatusCodes.SUSPENDED, null);

            capture.clear();
            int wakesBefore = mockingDetails(wakeups).getInvocations().size();
            recheck.recheck();
            int statements = capture.queries().size();
            int wakes = mockingDetails(wakeups).getInvocations().size() - wakesBefore;
            assertTrue(candidateExecutionId > 0L, "前提：候选执行的 id 必须落库");
            return new Measure(statements, wakes);
        }

        /** 落一条执行行；{@code completedAt} 为 null 表示未结束（不写 started_at）。 */
        private long insertExecution(long sessionId, int status, LocalDateTime completedAt) {
            return insertExecution(sessionId, status, null, completedAt);
        }

        /**
         * 落一条执行行。
         *
         * <p>{@code startedAt} 是「已注入」判据的锚点：只有在该任务完成之后<b>才开始</b>且正常完成的执行
         * 才能证明注入发生过；{@code null} 表示这一轮从未开始（旧数据 / 未启动）。</p>
         */
        private long insertExecution(long sessionId, int status, LocalDateTime startedAt, LocalDateTime completedAt) {
            ExecutionPO row = new ExecutionPO();
            row.setSessionId(sessionId);
            row.setStatus(status);
            row.setVersion(1L);
            row.setResumeGeneration(0L);
            row.setSnapshotFile("{}");
            row.setStartedAt(startedAt);
            row.setCompletedAt(completedAt);
            row.setCreatedAt(TASK_COMPLETE_AT);
            row.setUpdatedAt(TASK_COMPLETE_AT);
            executionMapper.insert(row);
            return row.getId();
        }

        /** 落一条终态任务：结果是否已被注入不在库里，只能靠「完成时间 vs 之后有无执行跑完」推断。 */
        private void insertTerminalTask(long taskId, long sessionId, LocalDateTime completeAt) {
            TaskPO row = new TaskPO();
            row.setId(taskId);
            row.setSessionId(sessionId);
            row.setTurnId(TURN_ID);
            row.setCommand("echo done");
            row.setOutput("");
            row.setStatus(Task.TaskStatus.SUCCESS.name());
            row.setExitCode(0);
            row.setTruncated(false);
            row.setCreateAt(taskTime(completeAt.minusHours(ORDER_GAP_HOURS)));
            row.setCompleteAt(taskTime(completeAt));
            taskMapper.insert(row);
        }

        /** 邮箱业务键的一半是会话 id：{@code workflow_execution_id} 列即邮箱会话。 */
        private long insertMailbox(long sessionId, long recipientAgentId) {
            EmailPO row = EmailPO.builder()
                    .id(sessionId)
                    .workflowExecutionId(sessionId)
                    .recipientAgentId(recipientAgentId)
                    .status(1)
                    .createAt(Instant.parse("2026-01-01T00:00:00Z"))
                    .updateAt(Instant.parse("2026-01-01T00:00:00Z"))
                    .build();
            emailMapper.insert(row);
            return row.getId();
        }

        /** 落一条消息；{@link EmailMessage.EMStatus#PENDING} 才是候选，{@code CONSUMED} 不算输入。 */
        private void insertMessage(long emailId, EmailMessage.EMStatus status) {
            EmailMessagePO row = EmailMessagePO.builder()
                    .id(emailId + 1_000_000_000L)
                    .emailId(emailId)
                    .senderId(MAIL_AGENT_ID)
                    .content("正文")
                    .status(status.name())
                    .createAt(Instant.parse("2026-01-01T00:00:00Z"))
                    .updateAt(Instant.parse("2026-01-01T00:00:00Z"))
                    .build();
            emailMessageMapper.insert(row);
        }

        /** 任务两列是 TIMESTAMP 且映射成 {@link Instant}：统一按 UTC 解释，避免受 JVM 默认时区影响。 */
        private static Instant taskTime(LocalDateTime value) {
            return value.toInstant(ZoneOffset.UTC);
        }

        @Override
        public void close() {
            database.shutdown();
        }
    }
}
