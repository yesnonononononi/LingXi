package com.summit.dp.agent;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.command.CommandChatRequest;
import com.summit.dp.agent.application.service.impl.ChatCommandAcceptance;
import com.summit.dp.agent.application.service.impl.PreparedChatExecutor;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.application.vo.CommandAcceptance;
import com.summit.dp.agent.application.vo.CommandAcceptanceVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.application.service.ExecutionRegistrationService;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * v2 命令受理的身份幂等（架构文档 §8.1 末段）。
 *
 * <p><b>为什么这三态必须钉死</b>：受理回执可能丢失，前端只能靠同一个 commandId 重发。
 * 若服务端把重试当成新命令受理，用户会看到两条一样的提问、两次模型调用；
 * 若把「同 ID 不同内容」也当重试放行，用户对第二次修改的意图会被静默丢弃；
 * 若把两者都拒绝，回执丢包就再也发不出消息。三条各有唯一正确解，所以用测试固定。</p>
 *
 * <p>不靠 sleep 制造时序：幂等判定是同步的，重试直接走仓储命中分支，
 * 异步派发段用计数器而不是等它完成 —— 被断言的是「有没有多写一次」。</p>
 */
class CommandAcceptanceIdempotencyTest {

    private static final long ROOT_SESSION_ID = 700L;
    private static final String COMMAND_ID = "cmd-1";
    private static final String EXECUTION_ID = "2105000000000000001";

    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ExecutionQueryService executionQuery = mock(ExecutionQueryService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionRegistrationService registrationService = mock(ExecutionRegistrationService.class);

    /** 记录「提交了几次用户消息」与「派发了几次执行」—— 幂等就是这两个数都必须是 1。 */
    private final AtomicInteger commits = new AtomicInteger();
    private final AtomicInteger dispatches = new AtomicInteger();

    private final ChatCommandAcceptance acceptance = new ChatCommandAcceptance(
            chatTurnService, requestPreparer, sseEventPublisher, registry, executionQuery,
            sessionRepository, mock(ResendTargetResolver.class), mock(ConversationRollbackService.class),
            new PreparedChatExecutor(orchestrator, modelContextService, registry,
                    registrationService, chatTurnService));

    @BeforeEach
    void stubHappyPath() {
        when(executionQuery.latestStatesBySession(any())).thenReturn(Map.of());
        when(requestPreparer.prepare(any())).thenReturn(context());
        when(chatTurnService.findByCommandId(anyString())).thenReturn(Optional.empty());
        // 编排器返回可用的执行对象：受理后的异步派发段会真的跑一遍，
        // 断言的仍是「提交了几次」，但至少不会在日志里留下 NPE 噪音。
        when(orchestrator.executeDefaultAgent(any())).thenReturn(stubExecution());

        // 用 doAnswer 而非 when(...).thenAnswer：后者在注册桩时会真实调用一次方法，
        // 计数器会被桩注册本身抬高，断言的就不再是「业务提交了几次」。
        doAnswer(invocation -> {
            commits.incrementAndGet();
            return 900L;
        }).when(requestPreparer).commitUserMessage(any(), anyString(), anyString());
    }

    /** 编排器交给下游的执行对象：只带会话归属，够恢复链路用。 */
    private static Execution stubExecution() {
        AgentRequest request = AgentRequest.builder()
                .executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .build())
                .build();
        Execution execution = Execution.builder().id(EXECUTION_ID).agentRequest(request).build();
        execution.setMessages(List.of());
        return execution;
    }

    @Test
    @DisplayName("同 commandId 同内容重试：查回首次结果，不重复写消息也不重复派发")
    void retryWithSameDigestReplaysFirstAcceptance() {
        CommandAcceptanceVO first = acceptance.accept(request("你好"));
        assertEquals(CommandAcceptance.ACCEPTED, first.acceptance());
        assertEquals(900L, first.turnId());

        // 第二次：仓储按 commandId 命中首次落库的那一轮，摘要与首次一致。
        when(chatTurnService.findByCommandId(COMMAND_ID))
                .thenReturn(Optional.of(turn(900L, request("你好").buildDigest())));

        CommandAcceptanceVO second = acceptance.accept(request("你好"));

        assertEquals(CommandAcceptance.REPLAYED, second.acceptance());
        assertEquals(first.turnId(), second.turnId(), "重试必须查回首次的轮次，不是新开一轮");
        assertEquals(first.sessionId(), second.sessionId());
        assertEquals(1, commits.get(), "同 commandId 重试不得再写一次用户消息");
        verify(registry, times(1)).beginRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("同 commandId 不同内容：拒绝，不当成重试也不新开一轮")
    void retryWithDifferentDigestIsRejected() {
        when(chatTurnService.findByCommandId(COMMAND_ID))
                .thenReturn(Optional.of(turn(900L, new CommandChatRequest(command("你好"), COMMAND_ID).buildDigest())));

        ClientException failure = assertThrows(ClientException.class,
                () -> acceptance.accept(request("换个问题")));

        assertTrue(failure.getMessage().contains("不同的请求内容"),
                "拒绝文案要说明是内容冲突，不能写成「稍后重试」：" + failure.getMessage());
        assertEquals(0, commits.get(), "被拒绝的命令不得留下用户消息");
        verify(registry, never()).beginRoot(any());
    }

    @Test
    @DisplayName("命令标识为空：直接拒绝，不建会话也不占运行资格")
    void blankCommandIdIsRejected() {
        ClientException failure = assertThrows(ClientException.class,
                () -> acceptance.accept(new CommandChatRequest(command("你好"), "  ")));

        assertTrue(failure.getMessage().contains("命令标识"));
        assertEquals(0, commits.get());
        verify(requestPreparer, never()).prepare(any());
    }

    @Test
    @DisplayName("提交失败：释放运行资格后抛出，不把会话锁死在执行中")
    void commitFailureReleasesRunQualification() {
        doThrow(new ClientException("落库失败"))
                .when(requestPreparer).commitUserMessage(any(), anyString(), anyString());

        assertThrows(ClientException.class, () -> acceptance.accept(request("你好")));

        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("不同 commandId 是两条独立命令，各自受理")
    void distinctCommandIdsAreDistinctCommands() {
        when(chatTurnService.findByCommandId("cmd-1")).thenReturn(Optional.empty());
        when(chatTurnService.findByCommandId("cmd-2")).thenReturn(Optional.empty());

        acceptance.accept(new CommandChatRequest(command("你好"), "cmd-1"));
        acceptance.accept(new CommandChatRequest(command("你好"), "cmd-2"));

        assertEquals(2, commits.get(), "不同命令标识各自受理，互不幂等");
    }

    @Test
    @DisplayName("摘要在字段拼接处不产生歧义：ab+c 与 a+bc 必须不同")
    void digestSeparatesFields() {
        String first = CommandChatRequestProbe.digestOf("ab", "c");
        String second = CommandChatRequestProbe.digestOf("a", "bc");
        assertNotEquals(first, second, "字段间若无分隔符，ab|c 与 a|bc 会算出同一摘要");
    }

    // ------------------------------------------------------------------
    // 替身
    // ------------------------------------------------------------------

    private static CommandChatRequest request(String input) {
        return new CommandChatRequest(command(input), COMMAND_ID);
    }

    private static ChatCommand command(String input) {
        return new ChatCommand(input, ROOT_SESSION_ID, 7L, null, null, null, false, null, null);
    }

    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, EXECUTION_ID,
                null, 7L, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).build(), List.of(), null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false, null);
    }

    private static ChatTurn turn(long turnId, String digest) {
        ChatTurn turn = ChatTurn.builder()
                .id(turnId)
                .sessionId(ROOT_SESSION_ID)
                .executionId(Long.parseLong(EXECUTION_ID))
                .status(ChatTurnStatus.ACCEPTED)
                .build();
        turn.attachCommand(COMMAND_ID, digest);
        return turn;
    }

    /** 只为让「命令标识相同但内容不同」的桩能造出带摘要的轮次。 */
    static final class CommandChatRequestProbe {
        static String digestOf(String... parts) {
            return com.summit.dp.shared.utils.CommandDigest.build((Object[]) parts);
        }
    }
}
