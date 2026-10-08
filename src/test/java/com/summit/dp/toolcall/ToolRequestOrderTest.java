package com.summit.dp.toolcall;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.toolcall.application.service.ToolRequestOrderRegistry;
import com.summit.dp.toolcall.infrastructure.listener.ToolRequestOrderInterceptor;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 工具请求顺序登记：顺序必须来自模型的 {@code toolCalls} **列表下标**，
 * 而不是「登记了几条」或「谁先完成」。
 *
 * <p>这是「工具块按模型意图排序」这件事的全部可观测后果 —— 顺序错了，
 * 前端就会把并发完成的工具按完成顺序展示，正好是本契约要避免的。</p>
 */
class ToolRequestOrderTest {

    private static final String EXECUTION_ID = "900";
    private static final UUID RESPONSE_ID = UUID.fromString("0d6a1f2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b");

    private final ToolRequestOrderRegistry registry = new ToolRequestOrderRegistry();
    private final ToolRequestOrderInterceptor interceptor = new ToolRequestOrderInterceptor(registry);

    /**
     * 顺序 = 模型请求列表下标。这里刻意把 {@code call_b} 排在 {@code call_a} 前面，
     * 断言 {@code call_b=0 / call_a=1} —— 若实现按字典序或按插入计数，这条会红。
     */
    @Test
    void orderFollowsModelRequestSequenceNotAlphabetical() {
        interceptor.onAfterModelInvoke(context(EXECUTION_ID),
                response("answer", request("call_b"), request("call_a")));

        assertEquals(0, registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_b").intValue());
        assertEquals(1, registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_a").intValue());
    }

    /** 未登记的工具返回 {@code null}（未知），绝不返回 0 冒充「第一个」。 */
    @Test
    void unknownToolCallReturnsNullNotZero() {
        interceptor.onAfterModelInvoke(context(EXECUTION_ID),
                response("answer", request("call_1")));

        assertNull(registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_never_requested"),
                "未登记必须是「未知」而不是序号 0：否则装配侧会把陌生工具排到最前");
        assertNull(registry.findOrder(EXECUTION_ID, UUID.randomUUID(), "call_1"));
    }

    /** 无工具请求的轮次不登记（那是循环出口，没有顺序可言）。 */
    @Test
    void responseWithoutToolCallsRegistersNothing() {
        interceptor.onAfterModelInvoke(context(EXECUTION_ID), response("final answer"));

        assertEquals(0, registry.executionCount(),
                "无工具请求的轮次不该产生任何登记档");
    }

    /** 同一执行内多次模型调用各归各的档：第二次调用的顺序不覆盖第一次。 */
    @Test
    void multipleModelCallsInOneExecutionKeepSeparateOrderTables() {
        UUID secondResponse = UUID.randomUUID();

        interceptor.onAfterModelInvoke(context(EXECUTION_ID),
                response(RESPONSE_ID, "第一轮", request("call_x"), request("call_y")));
        interceptor.onAfterModelInvoke(context(EXECUTION_ID),
                response(secondResponse, "第二轮", request("call_y"), request("call_x")));

        assertEquals(0, registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_x").intValue());
        assertEquals(1, registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_y").intValue());
        // 第二轮顺序相反：同一个 toolCallId 在不同 responseId 下各有各的位置。
        assertEquals(0, registry.findOrder(EXECUTION_ID, secondResponse, "call_y").intValue());
        assertEquals(1, registry.findOrder(EXECUTION_ID, secondResponse, "call_x").intValue());
    }

    /** 执行结束整体清档：不在册即为未知，且不同执行互不相干。 */
    @Test
    void runEndClearsOnlyThatExecution() {
        interceptor.onAfterModelInvoke(context(EXECUTION_ID),
                response("a", request("call_1")));
        interceptor.onAfterModelInvoke(context("901"),
                response("b", request("call_2")));

        assertEquals(2, registry.executionCount());

        interceptor.onRunEnd(execution(EXECUTION_ID));

        assertNull(registry.findOrder(EXECUTION_ID, RESPONSE_ID, "call_1"));
        assertEquals(1, registry.executionCount(), "只清本执行，别的执行仍在册");
        assertNotNull(registry.findOrder("901", RESPONSE_ID, "call_2"));
    }

    /** 缺少执行身份的上下文不登记（观测链路不做无主写入）。 */
    @Test
    void missingExecutionIdRegistersNothing() {
        interceptor.onAfterModelInvoke(context(null), response("a", request("call_1")));

        assertEquals(0, registry.executionCount());
    }

    // ── 构造助手 ──

    private static ToolCallRequest request(String id) {
        return ToolCallRequest.builder().id(id).name("read_file").arguments("{}").build();
    }

    private static ChatResponseEntity response(String text, ToolCallRequest... toolCalls) {
        return response(RESPONSE_ID, text, toolCalls);
    }

    private static ChatResponseEntity response(UUID responseId, String text, ToolCallRequest... toolCalls) {
        return ChatResponseEntity.builder()
                .responseId(responseId)
                .aiMessageEntity(AiMessageEntity.builder()
                        .text(text)
                        .toolCalls(List.of(toolCalls))
                        .build())
                .build();
    }

    private static LoopContext context(String executionId) {
        Execution execution = Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder().workspaceSpec(TEST_WORKSPACE).build())
                .build();
        return new LoopContext(execution, new ExecutionControlSignal(executionId), 0, Map.of(), ignored -> {
        });
    }

    private static Execution execution(String executionId) {
        return Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder().workspaceSpec(TEST_WORKSPACE).build())
                .build();
    }

    private static final WorkspaceSpec TEST_WORKSPACE = new WorkspaceSpec() {
        @Override
        public String provider() {
            return "test";
        }

        @Override
        public String workDir() {
            return "D:/tmp";
        }
    };
}
