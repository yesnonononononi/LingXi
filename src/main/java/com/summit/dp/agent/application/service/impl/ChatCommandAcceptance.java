package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.ExecutionState;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.command.CommandChatRequest;
import com.summit.dp.agent.application.vo.CommandAcceptance;
import com.summit.dp.agent.application.vo.CommandAcceptanceVO;
import com.summit.dp.agent.application.vo.ResendCommandAcceptanceVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * v2 命令受理脚本：发送与重发。
 *
 * <p><b>本类只保留顺序，顺序即不变量</b>（两条入口都一样，不可调换）：</p>
 * <ol>
 *   <li><b>命令幂等判定</b> —— 必须最先做。同 commandId 的重试若先走 prepare，
 *       会白白建出会话、生成新的 executionId，然后才在提交时撞上唯一索引；
 *       更糟的是「同 ID 不同内容」会先建出会话再报错，留一个空会话给用户。</li>
 *   <li><b>prepare 身份</b> —— 解析出确定的会话（新建会话也在此落库）。</li>
 *   <li><b>检查会话树空闲</b> —— 必须在拿到运行资格之前，冲突时用户消息还没落库。</li>
 *   <li><b>beginRoot</b> —— 取运行资格（单飞）。</li>
 *   <li><b>提交用户消息 / 业务轮次</b> —— 命令身份与轮次同事务落库。</li>
 *   <li><b>派发执行</b> —— 提交成功之后才派发。</li>
 * </ol>
 *
 * <p><b>为什么第 5 步失败必须走到第 4 步的反面</b>：提交失败时运行资格已经拿到了，
 * 不释放就会把会话永久锁死在「执行中」——用户既发不出下一条，也看不到任何错误。
 * 所以提交失败路径必须显式 {@code finishRoot} 后再抛。</p>
 *
 * <p><b>为什么受理与执行要分开</b>：受理成功只意味着「命令被接住了」，模型还没跑。
 * 回执因此只绑定命令与用户消息身份，不等第一条 assistant 事件，也不新建 assistant 副本 ——
 * 运行时通知完全可能先于 HTTP 回执到达，那也是合法的。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChatCommandAcceptance {

    private final ChatTurnService chatTurnService;
    private final RequestPreparer requestPreparer;
    private final SseEventPublisher sseEventPublisher;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ExecutionQueryService executionQueryService;
    private final SessionRepository sessionRepository;
    private final ResendTargetResolver resendTargetResolver;
    private final ConversationRollbackService conversationRollbackService;
    private final PreparedChatExecutor chatExecutor;

    /**
     * 发送受理。
     *
     * @param request 带命令身份的聊天请求
     * @return 受理回执
     */
    public CommandAcceptanceVO accept(CommandChatRequest request) {
        String commandId = requireCommandId(request);
        String digest = request.buildDigest();

        // 幂等判定先于一切副作用：同 ID 重试查回首次结果，不再写消息、不再开启执行。
        Optional<ChatTurn> replayed = findReplayed(request, commandId, digest);
        if (replayed.isPresent()) {
            return toAcceptanceVO(replayed.get(), commandId, CommandAcceptance.REPLAYED);
        }

        RuntimeContext context = requestPreparer.prepare(request.command());
        long rootSessionId = context.executionContext().rootSessionId();

        ensureSessionTreeIsIdle(rootSessionId);
        sseEventPublisher.prepareProjection(rootSessionId);
        sessionExecutionRegistry.beginRoot(rootSessionId);

        RuntimeContext committed;
        try {
            committed = context.withTurnId(requestPreparer.commitUserMessage(context, commandId, digest));
        } catch (RuntimeException commitFailure) {
            // 提交失败必须释放运行资格：否则会话被永久锁死，且没有任何错误提示。
            sessionExecutionRegistry.finishRoot(rootSessionId);
            throw commitFailure;
        }

        dispatchAsync(committed);

        return new CommandAcceptanceVO(context.executionContext().sessionId(), committed.turnId(),
                context.executionContext().executionId(), commandId, CommandAcceptance.ACCEPTED);
    }

    /**
     * 重发受理。
     *
     * <p><b>顺序约束（不可调换）</b>：回滚必须在取得运行资格之后（否则并发重发各砍一遍历史），
     * 且必须在提交用户消息之前（否则新提问会被自己刚做的回滚删掉）。</p>
     *
     * @param request 带命令身份的重发请求
     * @return 受理回执，额外带被作废范围与新的 historyRevision
     */
    public ResendCommandAcceptanceVO acceptResend(CommandChatRequest request) {
        String commandId = requireCommandId(request);
        String digest = request.buildDigest();

        // 与发送同一口径：幂等判定最先做。重发的回滚是破坏性的，
        // 绝不能因为一次重试就把历史再砍一遍。
        Optional<ChatTurn> replayed = findReplayed(request, commandId, digest);
        if (replayed.isPresent()) {
            ChatTurn turn = replayed.get();
            return new ResendCommandAcceptanceVO(turn.getSessionId(), turn.getId(),
                    turn.getExecutionId() == null ? null : String.valueOf(turn.getExecutionId()),
                    commandId, CommandAcceptance.REPLAYED,
                    readHistoryRevision(turn.getSessionId()), Set.of(), Set.of());
        }

        ChatCommand command = request.command();
        ResendTargetResolver.ResendTarget target = resendTargetResolver.resolve(command);
        RuntimeContext context = requestPreparer.prepareForResend(command, target.baseline());
        long rootSessionId = context.executionContext().rootSessionId();

        ensureSessionTreeIsIdle(rootSessionId);
        sseEventPublisher.prepareProjection(rootSessionId);
        sessionExecutionRegistry.beginRoot(rootSessionId);

        ConversationRollbackService.RollbackResult rollback;
        RuntimeContext committed;
        try {
            rollback = conversationRollbackService.rollbackBefore(
                    context.executionContext().sessionId(), target.turnId(), target.baseline());

            committed = context.withTurnId(requestPreparer.commitUserMessage(context, commandId, digest));
        } catch (RuntimeException prepareFailure) {
            // 回滚没成功就绝不能往下跑：新一轮会接在一段本该消失的历史之上。
            sessionExecutionRegistry.finishRoot(rootSessionId);
            throw prepareFailure;
        }

        dispatchAsync(committed);

        return new ResendCommandAcceptanceVO(context.executionContext().sessionId(), committed.turnId(),
                context.executionContext().executionId(), commandId, CommandAcceptance.ACCEPTED,
                rollback.historyRevision(), rollback.invalidatedTurnIds(), rollback.invalidatedExecutionIds());
    }

    /**
     * 派发执行。
     *
     * <p>刻意不在受理请求线程里跑模型：受理回执要立刻返回，而模型可能跑几十秒。
     * 派发本身失败（线程池拒绝）会走 {@link PreparedChatExecutor} 的收口路径吗？会 ——
     * 任务一旦被接受，收尾就在执行协作的 finally 里；这里只负责把任务交出去。</p>
     */
    private void dispatchAsync(RuntimeContext context) {
        CompletableFuture.runAsync(() -> {
            try {
                chatExecutor.run(context);
            } catch (RuntimeException e) {
                // 执行失败已被 chatExecutor 收口成终态，这里只记一笔：
                // 回执早已返回 accepted，前端靠轮次状态与事件流得知失败。
                log.error("受理后执行失败: sessionId={}, executionId={}, error={}",
                        context.executionContext().sessionId(),
                        context.executionContext().executionId(), e.toString());
            }
        });
    }

    /**
     * 命令幂等判定：命中且摘要一致才算重试。
     *
     * <p><b>同 ID 不同内容必须拒绝</b>，不能当重试放行、也不能新开一轮 ——
     * 前者是静默丢弃用户第二次的修改意图，后者会让同一命令标识对应两个轮次，
     * 之后任何一次按 commandId 查回都只能返回其中一个，另一个永远查不到。</p>
     */
    private Optional<ChatTurn> findReplayed(CommandChatRequest request, String commandId, String digest) {
        Optional<ChatTurn> existing = chatTurnService.findByCommandId(commandId);
        if (existing.isEmpty()) {
            return Optional.empty();
        }
        ChatTurn turn = existing.get();
        if (!turn.matchesCommandDigest(digest)) {
            throw new ClientException("同一命令标识对应了不同的请求内容，请刷新后重新发送");
        }
        log.info("命令重试查回首次受理结果: commandId={}, turnId={}", commandId, turn.getId());
        return Optional.of(turn);
    }

    private CommandAcceptanceVO toAcceptanceVO(ChatTurn turn, String commandId, CommandAcceptance acceptance) {
        return new CommandAcceptanceVO(turn.getSessionId(), turn.getId(),
                turn.getExecutionId() == null ? null : String.valueOf(turn.getExecutionId()),
                commandId, acceptance);
    }

    /**
     * 会话空闲防护：会话下任一执行尚未终结（CREATED / RUNNING / SUSPENDED）就拒绝开新一轮。
     *
     * <p>与 v1 入口同一口径、同一实现（{@code ExecutionQueryService.latestStatesBySession}）：
     * 两条入口的「能不能开新一轮」必须是同一个判定，否则用户从 v2 入口就能绕过
     * v1 的挂起防护，在同一会话里开出第二个根执行。</p>
     */
    private void ensureSessionTreeIsIdle(long rootSessionId) {
        List<ExecutionState> states =
                executionQueryService.latestStatesBySession(List.of(rootSessionId)).get(rootSessionId);
        if (states == null || states.isEmpty()) {
            return;
        }
        throwIf(states.contains(ExecutionState.SUSPENDED),
                "会话有等待恢复的执行，请先处理待审批事项或恢复执行");
        throwIf(states.stream().anyMatch(state -> !state.isTerminal()),
                "该会话正在执行中，请等待本轮结束或先停止");
    }

    /**
     * 重发重试查回时读当前历史版本。
     *
     * <p>重发没有真的执行回滚，历史版本没有被推进，读会话当前值即为正确答案。
     * 读不到就返回缺省 1：这是旁路展示字段，查不到不该让整条命令重试失败。</p>
     */
    private Long readHistoryRevision(Long sessionId) {
        return sessionRepository.findById(sessionId)
                .map(Session::getHistoryRevision)
                .orElse(1L);
    }

    private String requireCommandId(CommandChatRequest request) {
        if (request == null || request.commandId() == null || request.commandId().isBlank()) {
            throw new ClientException("命令标识不能为空");
        }
        return request.commandId().trim();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}
