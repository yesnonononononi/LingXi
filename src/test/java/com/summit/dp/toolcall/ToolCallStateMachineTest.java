package com.summit.dp.toolcall;

import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link ToolCall} 充血状态机单测（QA 补充覆盖）。
 *
 * <p>证明设计 §4.1 / §17-4 的硬约束：生命周期只有 {@code pending → in_progress → completed}
 * 三值；{@code completed} 为终态不可变；唯一流转入口 {@code transferTo} 幂等；
 * 「拒绝 / 取消 / 失败」不引入独立终态，一律落到 {@code completed}，
 * 区别只写在 {@code rawOutput.outcome}。</p>
 */
class ToolCallStateMachineTest {

    @Test
    void transferToIsTheOnlyEntryPointAndCompletedIsTerminalIdempotent() {
        ToolCall toolCall = promise("call-fsm");

        assertTrue(toolCall.complete("{\"outcome\":\"APPROVED\"}"));
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());

        // 终态幂等：重复 complete 返回 false，且不覆盖首次结论。
        assertFalse(toolCall.complete("{\"outcome\":\"REJECTED\"}"));
        assertEquals("{\"outcome\":\"APPROVED\"}", toolCall.getRawOutput());

        // 终态之后任何流转都被拒绝（无 FAILED/回退路径）。
        assertFalse(toolCall.transferTo(ToolCallStatus.IN_PROGRESS));
        assertFalse(toolCall.transferTo(ToolCallStatus.PENDING));
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
    }

    @Test
    void inProgressIsReachableAndIdempotentThenCompletes() {
        ToolCall toolCall = promise("call-inprog");

        assertTrue(toolCall.markInProgress());
        assertEquals(ToolCallStatus.IN_PROGRESS, toolCall.getStatus());
        // 同态重复流转是 no-op（不落库）。
        assertFalse(toolCall.markInProgress());
        assertTrue(toolCall.complete("{\"outcome\":\"APPROVED\",\"stdout\":\"ok\"}"));
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
    }

    @Test
    void rejectionAndCancellationBothSettleOnCompletedStatus() {
        ToolCall rejected = promise("call-rej");
        assertTrue(rejected.complete("{\"outcome\":\"" + ToolCallOutcome.REJECTED.value() + "\"}"));
        assertEquals(ToolCallStatus.COMPLETED, rejected.getStatus());

        ToolCall cancelled = promise("call-cancel");
        assertTrue(cancelled.complete("{\"outcome\":\"" + ToolCallOutcome.CANCELLED.value() + "\"}"));
        assertEquals(ToolCallStatus.COMPLETED, cancelled.getStatus());
    }

    @Test
    void statusEnumHasNoFailedOrCancelledTerminal() {
        for (ToolCallStatus status : ToolCallStatus.values()) {
            assertTrue(status == ToolCallStatus.PREPARING || status == ToolCallStatus.PENDING
                            || status == ToolCallStatus.IN_PROGRESS
                            || status == ToolCallStatus.COMPLETED,
                    "tool_call.status 只允许 pending/in_progress/completed，实际=" + status);
        }
    }

    @Test
    void promoteToPromiseUpgradesExecutePlaceholderAndIsNoOpOnceCompleted() {
        ToolCall executing = ToolCall.builder()
                .id("call-promote")
                .conversationId(1L)
                .executionId(2L)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.IN_PROGRESS)
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();

        executing.promoteToPromise(ToolCallType.PROMISE, "create_plan", "计划", "{\"kind\":\"PLAN\"}", "{\"args\":{}}");
        assertEquals(ToolCallType.PROMISE, executing.getType());
        assertEquals(ToolCallStatus.PREPARING, executing.getStatus());
        assertFalse(executing.isApprovalPending());
        assertFalse(executing.markInProgress());
        assertTrue(executing.markReady());
        assertFalse(executing.markReady());
        assertTrue(executing.isApprovalPending());

        // 已终态的行不因登记器 UPSERT 被降级。
        executing.complete("{\"outcome\":\"APPROVED\"}");
        executing.promoteToPromise(ToolCallType.PROMISE, "other", "t", "{}", "{}");
        assertEquals(ToolCallStatus.COMPLETED, executing.getStatus());
        assertEquals("create_plan", executing.getToolName());
    }

    @Test
    void attachOutputWritesConclusionWithoutChangingStatus() {
        ToolCall toolCall = promise("call-attach");
        toolCall.attachOutput("{\"outcome\":\"REJECTED\"}");
        assertEquals(ToolCallStatus.PENDING, toolCall.getStatus());
        assertEquals("{\"outcome\":\"REJECTED\"}", toolCall.getRawOutput());
    }

    @Test
    void approvalPendingRequiresBothPromiseTypeAndPendingStatus() {
        ToolCall promise = promise("call-approval");
        assertTrue(promise.isApprovalPending());

        ToolCall executing = ToolCall.builder()
                .id("call-exec")
                .conversationId(1L)
                .executionId(2L)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.PENDING)
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
        assertFalse(executing.isApprovalPending());
        assertNull(executing.getRawOutput());
    }

    private static ToolCall promise(String id) {
        return ToolCall.builder()
                .id(id)
                .conversationId(1L)
                .executionId(2L)
                .toolName("create_plan")
                .type(ToolCallType.PROMISE)
                .status(ToolCallStatus.PENDING)
                .title("计划")
                .content("{\"kind\":\"PLAN\"}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}
