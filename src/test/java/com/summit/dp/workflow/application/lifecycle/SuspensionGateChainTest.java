package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import com.summit.core.agent.ContextSpec;

/**
 * 门禁链与用户暂停门禁的语义回归。
 *
 * <p>守的是两条不变量：<b>顺序</b>（谁先拦住决定给用户看哪句原因）与
 * <b>「只有手动恢复能清暂停标记」</b>（自动唤醒替人解暂停，就是「按了暂停它自己又跑起来」）。</p>
 */
class SuspensionGateChainTest {

    private static final String EXECUTION_ID = "700";

    private final UserPauseSuspensionGate pauseGate = new UserPauseSuspensionGate();

    @Test
    @DisplayName("用户暂停：自动唤醒被拦，手动恢复放行")
    void userPausedBlocksAutomaticTriggersOnly() {
        Execution paused = execution(Map.of(InputAutomationPolicy.USER_PAUSED, true));

        GateCheckResult automatic = pauseGate.checkResumeReadiness(paused, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        assertFalse(automatic.allowed(), "有 USER_PAUSED 时自动唤醒必须被拦住");
        assertEquals("执行已由用户暂停", automatic.reason());

        assertTrue(pauseGate.checkResumeReadiness(paused, ResumeTriggerType.MANUAL_USER_RESUME).allowed(),
                "手动恢复本来就是来解暂停的，不能被自己拦");
    }

    @Test
    @DisplayName("连续自动接续到上限：自动唤醒被拦，手动恢复放行")
    void autoRoundLimitBlocksAutomaticTriggersOnly() {
        Execution rounds = execution(Map.of(InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS));

        GateCheckResult automatic = pauseGate.checkResumeReadiness(rounds, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        assertFalse(automatic.allowed());
        assertEquals("连续自动接续已达到 " + InputAutomationPolicy.MAX_AUTO_ROUNDS + " 轮上限", automatic.reason());

        assertTrue(pauseGate.checkResumeReadiness(rounds, ResumeTriggerType.MANUAL_USER_RESUME).allowed());
    }

    @Test
    @DisplayName("未到上限：自动唤醒放行")
    void belowAutoRoundLimitPasses() {
        Execution rounds = execution(Map.of(
                InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS - 1));

        assertTrue(pauseGate.checkResumeReadiness(rounds, ResumeTriggerType.AUTO_INPUT_WAKEUP).allowed());
    }

    @Test
    @DisplayName("清标记：只有手动触发才清 USER_PAUSED 与 AUTO_ROUNDS")
    void onlyManualTriggerClearsPauseMarkers() {
        Execution automatic = execution(Map.of(
                InputAutomationPolicy.USER_PAUSED, true,
                InputAutomationPolicy.AUTO_ROUNDS, 2));
        pauseGate.clearSuspensionState(automatic, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        assertTrue(InputAutomationPolicy.attributes(automatic).containsKey(InputAutomationPolicy.USER_PAUSED),
                "自动唤醒不得清掉人的暂停意图");
        assertTrue(InputAutomationPolicy.attributes(automatic).containsKey(InputAutomationPolicy.AUTO_ROUNDS),
                "自动唤醒不得重置自动轮次计数");

        Execution manual = execution(Map.of(
                InputAutomationPolicy.USER_PAUSED, true,
                InputAutomationPolicy.AUTO_ROUNDS, 2));
        pauseGate.clearSuspensionState(manual, ResumeTriggerType.MANUAL_USER_RESUME);
        assertFalse(InputAutomationPolicy.attributes(manual).containsKey(InputAutomationPolicy.USER_PAUSED));
        assertFalse(InputAutomationPolicy.attributes(manual).containsKey(InputAutomationPolicy.AUTO_ROUNDS));
    }

    @Test
    @DisplayName("门禁链：按 order 升序求值，第一个阻断即停，后续门禁不再执行")
    void chainEvaluatesInOrderAndStopsAtFirstBlock() {
        List<String> visited = new ArrayList<>();
        SuspensionGateChain chain = new SuspensionGateChain(List.of(
                recorder(visited, "third", 300, null),
                recorder(visited, "first", 100, "第一道拦住了"),
                recorder(visited, "second", 200, null)));

        GateCheckResult result = chain.checkReadiness(execution(Map.of()), ResumeTriggerType.AUTO_INPUT_WAKEUP);

        assertFalse(result.allowed());
        assertEquals("第一道拦住了", result.reason());
        assertEquals(List.of("first"), visited, "阻断后不得继续跑后面的门禁，也不得按注入顺序求值");
    }

    @Test
    @DisplayName("门禁链：全放行时才返回放行")
    void chainPassesWhenEveryGatePasses() {
        List<String> visited = new ArrayList<>();
        SuspensionGateChain chain = new SuspensionGateChain(List.of(
                recorder(visited, "second", 200, null),
                recorder(visited, "first", 100, null)));

        assertTrue(chain.checkReadiness(execution(Map.of()), ResumeTriggerType.MANUAL_USER_RESUME).allowed());
        assertEquals(List.of("first", "second"), visited, "清理与判定都必须按 order 升序");
    }

    @Test
    @DisplayName("门禁链：执行缺失时直接阻断，不把 null 传给门禁")
    void chainBlocksMissingExecution() {
        SuspensionGateChain chain = new SuspensionGateChain(List.of(pauseGate));

        assertFalse(chain.checkReadiness(null, ResumeTriggerType.MANUAL_USER_RESUME).allowed());
    }

    private static SuspensionGate recorder(List<String> visited, String name, int order, String blockReason) {
        return new SuspensionGate() {
            @Override
            public int order() {
                return order;
            }

            @Override
            public GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType) {
                visited.add(name);
                return blockReason == null ? GateCheckResult.pass() : GateCheckResult.blocked(blockReason);
            }

            @Override
            public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
                // 记录型门禁没有挂起痕迹要清。
            }
        };
    }

    private static Execution execution(Map<String, Object> attributes) {
        AgentRequest request = AgentRequest.builder().executionId(EXECUTION_ID)
                .contextSpec(ContextSpec.builder().context(List.of(UserMessageEntity.from("hi"))).build())
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(new HashMap<>(attributes)).build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).build();
    }
}
