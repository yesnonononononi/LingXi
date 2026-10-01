package com.summit.dp.turn;

import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 业务轮次的状态机与服务语义（2026-09-30 引入 chat_turn 的第一步）。
 *
 * <p>重点不在"字段被赋值了"，而在四条不变量：<b>终态不可改写、开始时间只设一次、
 * 用量覆盖且 null 不覆盖已知值、非法转移必须报错而不是静默纠正</b>。
 * 这四条正是"统计口径一致"能否成立的地基。</p>
 */
class ChatTurnLifecycleTest {

    private static final long TURN_ID = 7001L;
    private static final long SESSION_ID = 500L;
    private static final long EXECUTION_ID = 9001L;

    private static ChatTurn accepted() {
        return ChatTurn.accept(TURN_ID, SESSION_ID, null, "deepseek-chat", "deepseek");
    }

    @Nested
    @DisplayName("领域状态机")
    class Domain {

        @Test
        @DisplayName("受理即 ACCEPTED：没有开始时间也没有结束时间，模型快照当场就有")
        void acceptStartsAsAccepted() {
            ChatTurn turn = accepted();

            assertEquals(ChatTurnStatus.ACCEPTED, turn.getStatus());
            assertNull(turn.getStartedAt(), "受理 ≠ 开始执行");
            assertNull(turn.getCompletedAt());
            assertNull(turn.getTotalTokenCount(), "尚未采集用量必须是 null，不能是 0");
            assertEquals("deepseek-chat", turn.getModelName());
            assertNotNull(turn.getCreatedAt());
        }

        @Test
        @DisplayName("开始时间只设一次：恢复执行不重置，总历时从第一次开始算")
        void startedAtIsSetOnlyOnce() {
            ChatTurn turn = accepted();
            Instant first = Instant.now().minus(30, ChronoUnit.SECONDS);
            turn.markRunning(first);

            Instant later = Instant.now();
            turn.markWaiting();
            turn.markRunning(later);

            assertEquals(first, turn.getStartedAt(), "恢复不得重置首次开始时间");
            assertEquals(ChatTurnStatus.RUNNING, turn.getStatus());
        }

        @Test
        @DisplayName("挂起不是终态：转 WAITING 但不写结束时间，用量保留")
        void waitingIsNotTerminal() {
            ChatTurn turn = accepted();
            turn.markRunning(Instant.now());
            turn.refreshUsage(100L, 50L, 150L);

            turn.markWaiting();

            assertEquals(ChatTurnStatus.WAITING, turn.getStatus());
            assertNull(turn.getCompletedAt(), "挂起可恢复，不得写结束时间");
            assertEquals(150L, turn.getTotalTokenCount());
        }

        @Test
        @DisplayName("终态写入状态、结束时间与用量")
        void terminalStatesCarryTimesAndUsage() {
            for (ChatTurnStatus terminal : List.of(ChatTurnStatus.COMPLETED, ChatTurnStatus.FAILED,
                    ChatTurnStatus.CANCELLED)) {
                ChatTurn turn = accepted();
                Instant at = Instant.now();
                finish(turn, terminal, 120L, 30L, 150L, at);

                assertEquals(terminal, turn.getStatus());
                assertEquals(at, turn.getCompletedAt());
                assertEquals(150L, turn.getTotalTokenCount());
                assertTrue(turn.getStatus().isTerminal());
            }
        }

        @Test
        @DisplayName("终态不可改写：同终态幂等，异终态报错（后续通知失败不能改掉已保存的终态）")
        void terminalIsImmutable() {
            ChatTurn turn = accepted();
            turn.markCompleted(100L, 50L, 150L, Instant.now());

            // 同一终态的重复通知：幂等，只补齐用量，不动状态与结束时间。
            Instant firstCompletedAt = turn.getCompletedAt();
            turn.markCompleted(120L, 60L, 180L, Instant.now().plusSeconds(60));
            assertEquals(ChatTurnStatus.COMPLETED, turn.getStatus());
            assertEquals(firstCompletedAt, turn.getCompletedAt(), "重复通知不得改写结束时间");
            assertEquals(180L, turn.getTotalTokenCount(), "重复通知可补齐用量");

            // 试图改成另一种终态：必须报错，而不是静默把已完成改成失败。
            assertThrows(IllegalStateException.class,
                    () -> turn.markFailed(null, null, null, Instant.now()));
            assertThrows(IllegalStateException.class, turn::markWaiting);
            assertThrows(IllegalStateException.class, () -> turn.markRunning(Instant.now()));
        }

        @Test
        @DisplayName("失败原因只写轮次、不改状态：即便先于终态通知到达也不会把轮次改成 FAILED")
        void failureReasonDoesNotChangeStatus() {
            ChatTurn turn = accepted();
            turn.recordFailureReason("模型服务不可用");

            assertEquals(ChatTurnStatus.ACCEPTED, turn.getStatus(), "状态由框架生命周期信号驱动");
            assertEquals("模型服务不可用", turn.getErrorReason());

            // 空文案不覆盖已有值。
            turn.recordFailureReason(null);
            turn.recordFailureReason("  ");
            assertEquals("模型服务不可用", turn.getErrorReason());
        }

        @Test
        @DisplayName("用量覆盖而非累加；null 不覆盖已知值（未采集到 ≠ 0）")
        void usageIsOverwrittenAndNullNeverClobbers() {
            ChatTurn turn = accepted();
            turn.refreshUsage(100L, 50L, 150L);

            // 同一累计值重复写入：不得翻倍。
            turn.refreshUsage(100L, 50L, 150L);
            assertEquals(150L, turn.getTotalTokenCount(), "覆盖语义，不得累加");

            // 未采集到（null）不得把已知值抹成 null，也不得写成 0。
            turn.refreshUsage(null, null, null);
            assertEquals(100L, turn.getInputTokenCount());
            assertEquals(150L, turn.getTotalTokenCount());

            // 确实为 0 是合法值，要如实写入。
            turn.refreshUsage(0L, 0L, 0L);
            assertEquals(0L, turn.getTotalTokenCount(), "已知为 0 与未知必须可区分");
        }

        @Test
        @DisplayName("执行归属可重复回填同一个值，但不允许改绑到另一个执行")
        void executionBindingIsIdempotentButNotRebindable() {
            ChatTurn turn = accepted();
            turn.attachExecution(EXECUTION_ID);
            turn.attachExecution(EXECUTION_ID);
            assertEquals(EXECUTION_ID, turn.getExecutionId());

            assertThrows(IllegalStateException.class, () -> turn.attachExecution(EXECUTION_ID + 1),
                    "改绑会让统计挪到别的执行上，宁可报错");
        }

        @Test
        @DisplayName("挂起可重复：审批续跑会再次回到 SUSPENDED，RUNNING → WAITING → WAITING 必须幂等")
        void markWaitingIsIdempotent() {
            ChatTurn turn = accepted();
            turn.markRunning(Instant.now());
            turn.markWaiting();
            // 审批 CONTINUE 后执行回到 SUSPENDED，框架会再次发出挂起信号 —— 这里不能报错。
            turn.markWaiting();
            assertEquals(ChatTurnStatus.WAITING, turn.getStatus());

            // 受理后直接终结（启动前就失败）是合法路径，不能要求必须经过 RUNNING。
            ChatTurn early = accepted();
            early.markFailed(null, null, null, Instant.now());
            assertEquals(ChatTurnStatus.FAILED, early.getStatus());
        }

        private void finish(ChatTurn turn, ChatTurnStatus status, Long in, Long out, Long total, Instant at) {
            switch (status) {
                case COMPLETED -> turn.markCompleted(in, out, total, at);
                case FAILED -> turn.markFailed(in, out, total, at);
                case CANCELLED -> turn.markCancelled(in, out, total, at);
                default -> throw new IllegalArgumentException("非终态: " + status);
            }
        }
    }

    @Nested
    @DisplayName("应用服务")
    class Service {

        private final ChatTurnRepository repository = mock(ChatTurnRepository.class);
        private final ChatTurnService service = new ChatTurnServiceImpl(repository);

        @Test
        @DisplayName("受理：落库 ACCEPTED，并带上业务已生成的执行 ID（观察钩子靠它找回轮次）")
        void acceptPersistsAcceptedTurnWithExecutionId() {
            long turnId = service.acceptTurn(SESSION_ID, null, EXECUTION_ID, "deepseek-chat", "deepseek");

            ArgumentCaptor<ChatTurn> saved = ArgumentCaptor.forClass(ChatTurn.class);
            verify(repository).save(saved.capture());
            assertEquals(turnId, saved.getValue().getId());
            assertEquals(SESSION_ID, saved.getValue().getSessionId());
            assertEquals(EXECUTION_ID, saved.getValue().getExecutionId(),
                    "受理时就必须写入执行 ID：留空会让 START 事件找不到本轮次");
            assertNull(saved.getValue().getParentTurnId(), "普通提问不是子委派");
            assertEquals(ChatTurnStatus.ACCEPTED, saved.getValue().getStatus());
        }

        @Test
        @DisplayName("找不到轮次时静默跳过：旧执行没有轮次行是预期形态，不是异常")
        void missingTurnIsSkippedQuietly() {
            when(repository.findByExecutionId(EXECUTION_ID)).thenReturn(Optional.empty());

            service.markRunning(String.valueOf(EXECUTION_ID), Instant.now());
            service.markWaiting(String.valueOf(EXECUTION_ID));
            service.refreshUsage(String.valueOf(EXECUTION_ID), 1L, 2L, 3L);

            verify(repository, never()).updateById(any());
        }

        @Test
        @DisplayName("非数字执行 ID（框架兜底 UUID）同样跳过，不抛异常")
        void nonNumericExecutionIdIsSkipped() {
            service.markRunning("3f1c9a2e-uuid", Instant.now());
            verifyNoInteractions(repository);
        }

        @Test
        @DisplayName("markTerminal 只接受终态：传非终态直接拒绝")
        void markTerminalRejectsNonTerminal() {
            assertThrows(IllegalArgumentException.class,
                    () -> service.markTerminal(String.valueOf(EXECUTION_ID), ChatTurnStatus.RUNNING,
                            null, null, null, Instant.now()));
            assertThrows(IllegalArgumentException.class,
                    () -> service.markTerminal(String.valueOf(EXECUTION_ID), null,
                            null, null, null, Instant.now()));
        }

        @Test
        @DisplayName("按 executionId 唯一键定位轮次并推进状态")
        void mutatesByExecutionIdLookup() {
            ChatTurn turn = accepted();
            when(repository.findByExecutionId(EXECUTION_ID)).thenReturn(Optional.of(turn));

            Instant startedAt = Instant.now();
            service.markRunning(String.valueOf(EXECUTION_ID), startedAt);
            service.markTerminal(String.valueOf(EXECUTION_ID), ChatTurnStatus.COMPLETED,
                    10L, 20L, 30L, Instant.now());

            assertEquals(ChatTurnStatus.COMPLETED, turn.getStatus());
            assertEquals(startedAt, turn.getStartedAt());
            assertEquals(30L, turn.getTotalTokenCount());
            verify(repository, org.mockito.Mockito.times(2)).updateById(turn);
        }

        @Test
        @DisplayName("批量反查按执行 ID 为键，便于历史接口一次映射")
        void batchLookupIsKeyedByExecutionId() {
            ChatTurn turn = accepted();
            turn.attachExecution(EXECUTION_ID);
            when(repository.findByExecutionIds(any())).thenReturn(List.of(turn));

            Map<Long, ChatTurn> result = service.findByExecutionIds(List.of(EXECUTION_ID));

            assertEquals(1, result.size());
            assertEquals(turn, result.get(EXECUTION_ID));
            assertTrue(service.findByExecutionIds(List.of()).isEmpty());
            assertTrue(service.findByExecutionIds(null).isEmpty());
        }

        @Test
        @DisplayName("批量反查跳过没有执行 ID 的轮次（受理中尚未绑定，无法按执行反查）")
        void batchLookupSkipsTurnsWithoutExecutionId() {
            when(repository.findByExecutionIds(any())).thenReturn(List.of(accepted()));

            assertTrue(service.findByExecutionIds(List.of(EXECUTION_ID)).isEmpty());
        }
    }
}
