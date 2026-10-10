package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.skill.SkillRootResolver;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationSubmitter;
import com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationRecorder;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.AsyncDelegationResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 交付总监独立验证（QA 严过关）—— 协作式受理结果与异步提交被拒路径的<b>对抗性</b>用例。
 *
 * <p>用一条独特哨兵串证明「协作式不含正文」不是因为「没有产出正文」这种假绿，而是工具线程
 * 真的不跑子 loop；并补上「提交器拒绝提交」路径的 fail-closed 断言。</p>
 */
class QaAsyncDelegationAdversarialTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long CHILD_AGENT_ID = 7L;
    private static final long TEAM_ID = 3L;
    /** 独特哨兵：出现在子代理最终正文里，协作式结果中绝不应出现。 */
    private static final String SENTINEL = "QA_SENTINEL_7f3a_子代理正文_2c";

    private final ObjectMapper objectMapper = new ObjectMapper();

    private final AgentService agentService = mock(AgentService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final SubAgent subAgent = mock(SubAgent.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
            mock(com.summit.dp.turn.application.service.ChatTurnService.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);

    QaAsyncDelegationAdversarialTest() {
        lenient().when(settingsProvider.current()).thenReturn(Optional.empty());
        lenient().when(modelService.runtimeConfig(anyLong(), any())).thenReturn(
                com.summit.core.conf.ModelConfig.builder()
                        .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());
        lenient().when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));
    }

    /** 用「可注入提交器」构造工具：便于分别验证正常提交与「提交被拒」两条路径。 */
    private CallSubAgentTool toolWith(AsyncDelegationSubmitter submitter) {
        SubAgentRequestFactory requestFactory = new SubAgentRequestFactory(workspaceService, modelService,
                settingsProvider, mock(WorkspaceConverter.class), new SkillRootResolver(""));
        SubSessionResolver subSessionResolver = new SubSessionResolver(sessionRepository, modelContextService);
        DelegationRecorder recorder = new DelegationRecorder(chatTurnService, transcriptService);
        return new CallSubAgentTool(objectMapper, agentService, teamService, requestFactory,
                subSessionResolver, registry, sessionRepository, submitter,
                new AsyncDelegationResultRenderer(objectMapper));
    }

    private AgentVO childAgent() {
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        agent.setModelId(4L);
        agent.setToolList(List.of("read_file"));
        return agent;
    }

    private TeamVO team() {
        return TeamVO.builder().id(TEAM_ID).commanderAgentId(5L).agents(List.of(childAgent())).build();
    }

    private ToolExecution toolExecution() {
        ToolExecution execution = mock(ToolExecution.class);
        lenient().when(execution.getExecutionId()).thenReturn(String.valueOf(ROOT_EXECUTION_ID));
        lenient().when(execution.getId()).thenReturn("call-1");
        lenient().when(execution.getArgs()).thenReturn(args());
        lenient().when(execution.getAttributes()).thenReturn(Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.TEAM_ID, String.valueOf(TEAM_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)));
        lenient().when(execution.getEventMetaData()).thenReturn(Map.of("turnId", "9001"));
        return execution;
    }

    private String args() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agentId", CHILD_AGENT_ID);
        payload.put("task", "复现并定位主流程抖动");
        payload.put("prompt", "上下文");
        payload.put("workDir", "wd-a");
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void stubAgentAndTeam() {
        when(agentService.findById(CHILD_AGENT_ID)).thenReturn(Result.success(childAgent()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(team()));
    }

    private Execution completedWithSentinel() {
        Execution execution = mock(Execution.class);
        when(execution.getMessages()).thenReturn(List.of(UserMessageEntity.from(SENTINEL)));
        return execution;
    }

    @Test
    @DisplayName("对抗：协作式结果键集合恰好 6 个、非 PROMISE、≤5s、且不含子代理正文哨兵")
    void asyncResultIsExactStructuredJsonWithoutBody() throws Exception {
        stubAgentAndTeam();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(anyLong(), anyLong())).thenReturn(true);
        // 子代理若真被执行，正文会带哨兵；协作式不得把这份正文漏出去。
        Execution sentinelExecution = completedWithSentinel();
        when(subAgent.execute(any(AgentRequest.class))).thenReturn(sentinelExecution);

        long startedAt = System.currentTimeMillis();
        ToolExecuteResult result = toolWith(mock(AsyncDelegationSubmitter.class)).execute(toolExecution());
        long elapsed = System.currentTimeMillis() - startedAt;

        assertTrue(result.isSuccess());
        assertFalse(result.isPromise(), "协作式结果不得是 PROMISE，否则根执行永挂");
        assertTrue(elapsed <= 5_000L, "必须在 5s 内返回，实际=" + elapsed);

        JsonNode json = objectMapper.readTree(result.getToolOutput());
        Set<String> keys = new TreeSet<>();
        json.fieldNames().forEachRemaining(keys::add);
        assertEquals(Set.of("runtimeMode", "delegated", "subSessionId", "agentId", "agentName", "note"), keys,
                "键集合必须恰好为约定的六个");
        assertEquals("ASYNC", json.get("runtimeMode").asText());
        assertTrue(json.get("delegated").asBoolean());
        assertTrue(json.get("subSessionId").isTextual());
        assertFalse(json.get("subSessionId").asText().isBlank());
        assertEquals(CHILD_AGENT_ID, json.get("agentId").asLong());
        assertFalse(json.get("agentName").asText().isBlank());
        // 回执仅表示受理，缺邮件不能成为主理人放弃验收的理由。
        assertTrue(json.get("note").asText().contains("核验工作目录中的产物和验证记录"),
                "受理回执须引导主理人验收产物");
        assertTrue(json.get("note").asText().contains("没有邮件也应自行验收"), "缺邮件不能阻断收口");

        String output = result.getToolOutput();
        assertFalse(output.contains(SENTINEL), "协作式结果严禁包含子代理正文");
        assertTrue(output.trim().startsWith("{"), "结果主体应为协作式 JSON 对象，实际=" + output);
        assertTrue(output.contains("\"runtimeMode\":\"ASYNC\""), "结果应含 runtimeMode=ASYNC 字面量");
    }

    @Test
    @DisplayName("异步提交被拒（线程池拒绝）：工具必须 fail-closed 返回错误，撤销登记且不产生任何落库副作用")
    void rejectedSubmissionFailsClosedWithoutSideEffects() {
        stubAgentAndTeam();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(anyLong(), anyLong())).thenReturn(true);

        // 真提交器 + 拒绝执行的线程池：走真实 submit() 逻辑。
        AsyncDelegationSubmitter rejecting = new AsyncDelegationSubmitter(subAgent, registry,
                mock(SubSessionResolver.class), mock(DelegationRecorder.class),
                modelContextService, mock(ExecutionControl.class), mock(SubExecutionLifecycle.class));
        org.springframework.test.util.ReflectionTestUtils.setField(rejecting, "executorService",
                new RejectingExecutorService());

        ToolExecuteResult result = toolWith(rejecting).execute(toolExecution());

        assertNotNull(result);
        assertFalse(result.isSuccess(), "提交未成功时不得谎报成功（否则模型以为已委派）");
        // 提交失败 → 撤销待启动登记；异步体从未运行 → 不建会话行 / 不落账 / 不建执行。
        verify(registry).revokeChild(eq(ROOT_SESSION_ID), anyLong());
        verify(subAgent, never()).createExecution(any());
        verify(subAgent, never()).execute(any(Execution.class));
        verify(subAgent, never()).execute(any(AgentRequest.class));
    }

    /** 拒绝一切提交的执行器：模拟线程池已关闭 / 饱和。 */
    private static final class RejectingExecutorService extends AbstractExecutorService {
        @Override
        public void execute(Runnable command) {
            throw new RejectedExecutionException("qa: executor rejected");
        }

        @Override
        public void shutdown() {
        }

        @Override
        public List<Runnable> shutdownNow() {
            return List.of();
        }

        @Override
        public boolean isShutdown() {
            return true;
        }

        @Override
        public boolean isTerminated() {
            return true;
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return true;
        }
    }
}
