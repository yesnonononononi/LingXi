package com.summit.dp.workflow.application.lifecycle;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/**
 * 未决工具门禁的真实 SQL 回归。
 *
 * <p>用真 H2 + 真 {@link ToolCallRepositoryImpl}：mock 只能证明「方法被调用过」，
 * 证明不了未决谓词真的下推到 SQL、也证明不了非 PROMISE 与已完成的卡片不会误拦恢复。</p>
 */
class UnresolvedToolSuspensionGateH2Test {

    private static final long EXECUTION_ID = 900L;
    private static final long CONVERSATION_ID = 800L;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl toolCalls;
    private UnresolvedToolSuspensionGate gate;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("UnresolvedToolSuspensionGateH2Test");
        capture = new SqlCaptureInterceptor();
        SqlSessionFactory factory = database.sessionFactory(ToolCallMapper.class);
        factory.getConfiguration().addInterceptor(capture);
        toolCalls = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(factory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), new CardAvailabilityPolicy(
                        new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class))));
        gate = new UnresolvedToolSuspensionGate(toolCalls);
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("有未决槽位：手动与自动都被拦，原因就是给用户看的那句业务提示")
    void pendingSlotBlocksBothTriggers() {
        toolCalls.save(card("c-pending", ToolCallType.PROMISE, ToolCallStatus.PENDING));
        Execution execution = execution();

        GateCheckResult manual = gate.checkResumeReadiness(execution, ResumeTriggerType.MANUAL_USER_RESUME);
        assertFalse(manual.allowed(), "手动恢复有未决槽位必须明确拒绝");
        assertEquals("请先处理待审批事项", manual.reason());

        GateCheckResult automatic = gate.checkResumeReadiness(execution, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        assertFalse(automatic.allowed(), "自动唤醒同样不能越过未决槽位");
    }

    @Test
    @DisplayName("准备中与执行中都算未决：只看 pending 会漏掉它们")
    void preparingAndInProgressAlsoBlock() {
        toolCalls.save(card("c-preparing", ToolCallType.PROMISE, ToolCallStatus.PREPARING));
        assertFalse(gate.checkResumeReadiness(execution(), ResumeTriggerType.MANUAL_USER_RESUME).allowed(),
                "准备中的槽位也算未决");

        ToolCall running = toolCalls.findById("c-preparing").orElseThrow();
        // PREPARING 只能先进 PENDING（放行），再进 IN_PROGRESS；跳过放行会被领域方法拒绝。
        assertTrue(running.markReady(), "前置：槽位必须能从准备中放行为待处理");
        assertTrue(running.markInProgress(), "前置：槽位必须能待处理推进到执行中");
        toolCalls.updateById(running);
        assertFalse(gate.checkResumeReadiness(execution(), ResumeTriggerType.MANUAL_USER_RESUME).allowed(),
                "执行中的槽位同样算未决");
    }

    @Test
    @DisplayName("已完成的 PROMISE 与非 PROMISE 类型都不是未决槽位")
    void completedAndExecuteTypeDoNotBlock() {
        toolCalls.save(card("c-done", ToolCallType.PROMISE, ToolCallStatus.COMPLETED));
        toolCalls.save(card("c-execute", ToolCallType.EXECUTE, ToolCallStatus.PENDING));

        assertTrue(gate.checkResumeReadiness(execution(), ResumeTriggerType.MANUAL_USER_RESUME).allowed(),
                "已落定或非 PROMISE 的卡片不得拦住恢复，否则会话永远起不来");
    }

    @Test
    @DisplayName("单次判定只发一条 SELECT，且未决谓词下推到 SQL（type 等值 + 状态 IN）")
    void singleQueryCarriesTheUnresolvedPredicate() {
        toolCalls.save(card("c-pending", ToolCallType.PROMISE, ToolCallStatus.PENDING));
        capture.clear();

        assertFalse(gate.checkResumeReadiness(execution(), ResumeTriggerType.AUTO_INPUT_WAKEUP).allowed());

        assertEquals(1, capture.queries().size(), "一次判定只允许一次查询，实际: " + capture.queries());
        String sql = SqlCaptureInterceptor.normalize(capture.queries().getFirst());
        assertTrue(sql.contains("from tool_call"), "必须查 tool_call: " + sql);
        assertTrue(SqlCaptureInterceptor.hasColumn(sql, "type"), "未决谓词必须下推到 SQL: " + sql);
        assertTrue(sql.contains(" in "), "状态枚举必须是 IN 条件: " + sql);
        assertTrue(sql.contains("execution_id"), "必须按执行过滤，不能全表扫: " + sql);
    }

    @Test
    @DisplayName("执行标识缺失直接抛错，绝不当作「没有未决槽位」放行")
    void missingExecutionIdFailsLoudly() {
        Execution broken = Execution.builder().id("not-a-number").agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId("not-a-number")
                        .messages(List.of(UserMessageEntity.from("hi")))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(new HashMap<>()).build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).build();

        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> gate.checkResumeReadiness(broken, ResumeTriggerType.MANUAL_USER_RESUME));
        assertTrue(error.getMessage().contains("not-a-number"), error.getMessage());
    }

    private static ToolCall card(String id, ToolCallType type, ToolCallStatus status) {
        return ToolCall.builder()
                .id(id).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName("ask_user").type(type).status(status)
                .title("选择")
                .content("{\"kind\":\"CHOICE\",\"question\":\"选一个\"}")
                .rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static Execution execution() {
        Map<String, Object> attributes = new HashMap<>();
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(List.of(UserMessageEntity.from("hi")))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).build();
    }
}
