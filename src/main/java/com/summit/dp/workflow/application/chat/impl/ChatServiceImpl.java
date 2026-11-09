package com.summit.dp.workflow.application.chat.impl;

import com.summit.core.agent.Execution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.model.ExecutionStatus;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.chat.*;
import com.summit.dp.workflow.application.chat.ConversationRollbackService.ResendAdmission;
import com.summit.dp.workflow.application.chat.ResendTargetResolver.ResendTarget;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleOrchestrator;
import com.summit.dp.workflow.application.lifecycle.ResumeAcceptResult;
import com.summit.dp.workflow.application.lifecycle.ResumeRequest;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

/**
 * 会话聊天编排：负责"会话 → 工作空间（运行环境）"的解析与续接。
 *
 * <p><b>HC-2 执行身份前置</b>：必须先 {@link RequestPreparer#prepare} 解析出确定的会话
 * （新建会话也在此步落库），再 {@code beginRoot} 注册运行与订阅 SSE。原先「先 beginRoot
 * 后 prepare」会让新建会话的首次对话把 null 注册进运行表，停止链路对着空气取消。</p>
 */
@RequiredArgsConstructor
@Service
@Slf4j
public class ChatServiceImpl implements ChatService {

    private final SseEventPublisher sseEventPublisher;
    private final RequestPreparer requestPreparer;
    /** 生命周期统一编排：暂停与恢复都从它走，ChatServiceImpl 不再直接碰控制信号。 */
    private final ExecutionLifecycleOrchestrator lifecycle;
    private final SessionRepository sessionRepository;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ExecutionLocator executionLocator;
    /** 已受理上下文的执行协作：模型调用与运行资格收尾都在它那里。 */
    private final PreparedChatExecutor chatExecutor;
    private final InputWakeupService inputWakeups;
    private final ExecutionQueryService executionQueryService;
    /** 重发目标的定位与校验；重发脚本本身只负责顺序。 */
    private final ResendTargetResolver resendTargetResolver;
    /** 重发回滚：把被改写的那条提问及其之后的整段历史从库里作废。 */
    private final ConversationRollbackService conversationRollbackService;
    private final SessionExecutionStopper executionStopper;
    private final PendingChatQueue pendingChats;

    @Override
    public Result<String> chat(ChatCommand command) {
        RuntimeContext context = requestPreparer.prepare(command);
        // 单飞校验前置到请求线程，且**先于用户消息落库**：冲突时执行尚未开始，
        // 用户消息也还没写进历史，不会留下「有提问、无执行、无错误」的孤行。
        beginImmediateRoot(context);
        return Result.success(executePrepared(context).getMessages().toString());
    }

    /**
     * 挂载 / 重挂会话事件流。
     *
     * <p>只订阅，不执行：不 prepare、不注册运行、不写任何会话状态，因此可以随时重复调用。
     * 会话标识按根会话解析，与 {@code AgentEventListener} 的推送路由同一口径 ——
     * 否则子会话订阅到的流会永远收不到事件。</p>
     *
     * <p>不回放历史：切走期间的缺口由前端回查会话历史补齐，本流只保证「挂上之后」的实时性。</p>
     */
    @Override
    public SseEmitter subscribeSession(Long sessionId) {
        // 入口校验：0 是「自身即根」的哨兵（Session.ROOT_SESSION_ID），不是合法会话主键。
        // 非正数必须在这里拒成业务错误，否则会落进 resolveRootSessionId 抛
        // IllegalStateException → 兜底 handler 报 HTTP 500「系统繁忙」。
        throwIf(sessionId == null || sessionId <= 0, "会话标识不合法");
        long rootSessionId = executionLocator.resolveRootSessionId(sessionId);
        return sseEventPublisher.connect(rootSessionId);
    }

    @Override
    public Result<ChatAcceptanceVO> acceptCommand(ChatCommand command) {
        throwIf(command == null, "聊天请求不能为空");
        RuntimeContext context;
        if (command.sessionId() == null || command.sessionId() <= 0) {
            context = requestPreparer.prepare(command);
            beginImmediateRoot(context);
        } else {
            long sessionId = command.sessionId();
            synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
                if (pendingChats.hasPending(sessionId) || sessionExecutionRegistry.isRootRunning(sessionId)
                        || hasUnfinishedRoot(sessionId) || ExecutionCoordination.isResumingSession(sessionId)) {
                    requireQueueSession(sessionId);
                    String pendingId = pendingChats.enqueue(sessionId, command);
                    return Result.success(ChatAcceptanceVO.builder().sessionId(sessionId).pendingId(pendingId).build());
                }
                context = requestPreparer.prepare(command);
                sessionExecutionRegistry.beginRoot(sessionId, context.executionContext().executionId());
            }
        }
        return Result.success(commitAndSubmit(context));
    }

    /** 会话门闩覆盖执行和恢复的上下文回写，终态提交只保证执行行可见。 */
    public void dispatchPending(long sessionId) {
        if (sessionExecutionRegistry.isRootRunning(sessionId) || ExecutionCoordination.isResumingSession(sessionId)) return;
        synchronized (ExecutionCoordination.monitor("session:" + sessionId)) {
            if (hasUnfinishedRoot(sessionId)) return;
        }

        PendingChatQueue.Ticket ticket;
        RuntimeContext context;
        synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
            if (sessionExecutionRegistry.isRootRunning(sessionId) || hasUnfinishedRoot(sessionId)
                    || ExecutionCoordination.isResumingSession(sessionId)) return;
            ticket = pendingChats.claim(sessionId);
            if (ticket == null) return;
            try {
                requireQueueSession(sessionId);
                context = requestPreparer.prepare(ticket.command());
                sessionExecutionRegistry.beginRoot(sessionId, context.executionContext().executionId());
            } catch (RuntimeException | LinkageError failure) {
                failPending(sessionId, ticket, failure);
                return;
            }
        }

        RuntimeContext committed;
        try {
            committed = commitUserMessage(context);
        } catch (RuntimeException | LinkageError failure) {
            failPending(sessionId, ticket, failure);
            return;
        }

        // 轮次已落库，启动失败也归该轮次收口，不能把同一需求再派一次。
        pendingChats.admitted(sessionId, ticket);
        chatExecutor.submitAsync(committed);
    }

    @Override
    public PendingChatQueue.Snapshot pendingCommands(long sessionId) {
        requireQueueSession(sessionId);
        return pendingChats.snapshot(sessionId);
    }

    @Override
    public void cancelPendingCommand(long sessionId, String pendingId) {
        requireQueueSession(sessionId);
        Long deferredExecutionId = pendingChats.cancel(sessionId, pendingId);
        if (deferredExecutionId != null) inputWakeups.resumeIfInputPending(deferredExecutionId);
    }

    @Override
    public void resumePendingCommands(long sessionId) {
        requireQueueSession(sessionId);
        synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
            pendingChats.resume(sessionId);
        }
    }

    /**
     * 重发：按 checkpoint 编辑当时那条提问后重跑一轮，该轮及其之后的历史全部作废。
     *
     * <p>顺序不能动：回滚必须在取到运行资格之后（否则并发重发各砍一遍历史），
     * 且必须在 {@code commitUserMessage} 之前（否则新提问会被自己删掉）。</p>
     *
     * <p>与 {@link #acceptCommand} 同形态：同步受理、异步执行、不建 emitter。</p>
     */
    @Override
    public Result<ChatAcceptanceVO> resend(ChatCommand command) {
        ResendTarget target = resendTargetResolver.resolve(command);

        // 上下文取目标轮次的历史基线
        RuntimeContext context = requestPreparer.prepareForResend(command, target.baseline());

        long rootSessionId = context.executionContext().rootSessionId();

        beginImmediateRoot(context);

        ResendAdmission admitted;
        try {
            // 回滚事务开始前先冻结运行配置：受理与回滚同事务，事务内不能再开写连接。
            requestPreparer.freezeRuntimeConfigurations(context);
            admitted = conversationRollbackService.rollbackAndAdmit(context, target);
        } catch (RuntimeException e) {
            // 回滚没成功就绝不能往下跑：否则新一轮会接在一段本该消失的历史之上。
            sessionExecutionRegistry.finishRoot(rootSessionId, context.executionContext().executionId());
            throw e;
        }

        // 异步执行晚于整个受理事务提交，避免模型读取到尚未提交的轮次或检查点。
        chatExecutor.submitAsync(admitted.context());
        return Result.success(ChatAcceptanceVO.builder()
                .sessionId(admitted.context().executionContext().sessionId()).turnId(admitted.context().turnId())
                .historyRevision(admitted.rollback().historyRevision())
                .invalidatedTurnIds(admitted.rollback().invalidatedTurnIds())
                .invalidatedExecutionIds(admitted.rollback().invalidatedExecutionIds()).build());
    }

    /**
     * 已拿到运行资格的上下文：请求线程同事务落库并取 turnId，随后异步只跑模型，返回受理回执。
     */
    private ChatAcceptanceVO commitAndSubmit(RuntimeContext context) {
        RuntimeContext committed = commitUserMessage(context);
        // 只跑模型：不建 emitter、不订阅；失败收口与运行资格释放在协作类内统一处理。
        chatExecutor.submitAsync(committed);
        return ChatAcceptanceVO.builder()
                .sessionId(context.executionContext().sessionId())
                .turnId(committed.turnId())
                .build();
    }

    /**
     * 共同受理入口：在请求线程同事务提交轮次、用户消息与执行行，返回带上 turnId 与执行对象的上下文。
     *
     * <p>普通发送经这里；重发由 {@code rollbackAndAdmit} 将历史作废一起纳入事务。
     * 登记动作统一由 {@code PreparedChatExecutor#admit} 完成 —— 本方法是
     * 私有自调用，事务注解挂在这里不会生效。</p>
     *
     * <p><b>提交失败必须自己释放运行资格</b>：{@code chatExecutor} 的收尾只在它被调用之后生效，
     * 提交抛异常时它根本没进 —— 不在这里补一次释放，会话会被永久锁死在「执行中」，
     * 用户既发不出下一条也看不到任何错误。</p>
     */
    private RuntimeContext commitUserMessage(RuntimeContext context) {
        try {
            // 运行配置先独立冻结，受理事务再引用该版本，避免恢复引用未提交的配置。
            requestPreparer.freezeRuntimeConfigurations(context);
            return chatExecutor.admit(context);
        } catch (RuntimeException | LinkageError commitFailure) {
            sessionExecutionRegistry.finishRoot(context.executionContext().rootSessionId(), context.executionContext().executionId());
            throw commitFailure;
        }
    }

    /**
     * 执行档位：团队 > 单 Agent > 裸模型。
     *
     * <p><b>为什么还留着这一层</b>：同步 {@code chat()} 要把执行结果交回给请求线程
     * （返回消息内容），而受理必须在请求线程同步提交。真正的模型调用与收尾已经搬进
     * {@link PreparedChatExecutor}，这里只保留「提交 → 委托 → 返回」三步。</p>
     */
    private Execution executePrepared(RuntimeContext context) {
        return chatExecutor.run(commitUserMessage(context));
    }

    @Override
    public void stop(Long sessionId) {
        Session selected = sessionRepository.findById(sessionId).orElse(null);
        Long rootSessionId = selected != null && selected.isSubSession()
                ? selected.getRootSessionId()
                : sessionId;

        executionStopper.stop(rootSessionId);
        log.info("请求停止会话树: sessionId={}, rootSessionId={}", sessionId, rootSessionId);

        // 不关流：会话流是会话级资源，生命周期跟页面挂载 / 卸载走。停止只取消执行 ——
        // 一旦在这里断开，前端下一次发送前就必须重新挂载，否则那段时间的事件无处可去。
    }

    @Override
    public void suspend(Long sessionId) {
        throwIf(sessionId == null || sessionId <= 0, "会话标识不合法");
        lifecycle.pauseSessionExecution(String.valueOf(sessionId));
    }

    /**
     * 手动恢复：同步预检 → 清挂起痕迹提交 → 交回 loop → 回写上下文。
     *
     * <p>编排、门禁与顺序都在 {@code ExecutionLifecycleOrchestrator} 里，入口只做两件事：
     * 取「被挂起的那个执行」，把门禁给的原因翻成业务错误。这样手动与自动两条恢复路径
     * 不会各养一份门禁判断。</p>
     */
    @Override
    public synchronized Result<String> resume(Long sessionId) {
        String executionId = executionLocator.latestSuspendedExecutionId(sessionId);
        throwIf(executionId == null, "该会话没有可恢复的执行");

        ResumeAcceptResult result = lifecycle.requestResume(
                ResumeRequest.create(executionId, sessionId, ResumeTriggerType.MANUAL_USER_RESUME));
        // 未决工具、用户暂停等原因必须原样回给用户：静默失败会让「点了恢复没反应」无从排查。
        throwIf(result.blocked(), result.reason());

        return Result.success(result.resumed().getMessages().toString());
    }

    /**
     * 根执行空闲防护：<b>只看根会话自身的执行</b>是否尚未终结（{@code CREATED} / {@code RUNNING} / {@code SUSPENDED}），
     * 非终态就拒绝开新一轮。恢复入口是审批卡片与 {@code /resume}，不是再发一条消息。
     *
     * <p><b>作用域是「根执行」而不是「整棵会话树」</b>：判定数据来自
     * {@code ExecutionQueryService.latestStatesBySession(List.of(rootSessionId))}，其 SQL 是
     * {@code session_id IN (rootSessionId)}。而执行行的 {@code session_id} 取自请求属性
     * {@code ExecutionAttributes.SESSION_ID}——<b>子执行</b>的该属性是<b>子会话 id</b>
     * （见 {@code SubAgentRequestFactory#childAttributes}），因此异步子执行天然不在判定范围内：
     * 协作模式下「子代理仍在跑」不会拦住用户开新一轮。这是 P0-4 要的语义。</p>
     *
     * <p><b>三个状态都要拦，缺一不可</b>：{@code SUSPENDED}（等待审批 / 子代理回填）自不必说；
     * {@code CREATED} / {@code RUNNING} 是<b>恢复执行</b>在跑 —— 恢复由结束事实协作器
     * （{@code SubExecutionLifecycle} → {@code ExecutionResumeCoordinator}）与 {@code /resume}
     * 直接交给 loop，不经过请求线程，
     * {@link SessionExecutionRegistry#beginRoot} 那把单飞锁在挂起时就已释放。只查 SUSPENDED
     * 会漏掉「挂起 → 子代理回填 → 已恢复并正在跑」这段窗口，用户于是能在同一会话里开出第二个
     * 根执行：线上事故里两条「继续推进」各跑出一份交付总结，前端两个气泡同时收事件。</p>
     */
    private void ensureRootExecutionIdle(long rootSessionId) {
        List<ExecutionStatus> states = rootStates(rootSessionId);
        throwIf(states.contains(ExecutionStatus.SUSPENDED), "会话有等待恢复的执行，请先处理待审批事项或恢复执行");
        throwIf(states.stream().anyMatch(state -> !state.isTerminal()),
                "该会话正在执行中，请等待本轮结束或先停止");
    }

    private List<ExecutionStatus> rootStates(long sessionId) {
        return executionQueryService.latestStatesBySession(List.of(sessionId)).getOrDefault(sessionId, List.of());
    }

    private boolean hasUnfinishedRoot(long sessionId) {
        return rootStates(sessionId).stream().anyMatch(state -> !state.isTerminal());
    }

    private void beginImmediateRoot(RuntimeContext context) {
        long rootSessionId = context.executionContext().rootSessionId();
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            ensureRootExecutionIdle(rootSessionId);
            throwIf(pendingChats.hasPending(rootSessionId), "会话有待发送消息，请先处理队列");
            sessionExecutionRegistry.beginRoot(rootSessionId, context.executionContext().executionId());
        }
    }

    private void requireQueueSession(long sessionId) {
        Session session = sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        throwIf(session.isSubSession(), "请在根会话中管理待发送消息");
    }

    private void failPending(long sessionId, PendingChatQueue.Ticket ticket, Throwable failure) {
        String message = failure instanceof ClientException && failure.getMessage() != null
                ? failure.getMessage() : "待发送消息受理失败，请重试";
        pendingChats.failed(sessionId, ticket, message);
        log.warn("待发送消息受理失败: sessionId={}, pendingId={}", sessionId, ticket.id(), failure);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

}
