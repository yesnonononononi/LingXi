package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver.ResendTarget;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.shared.exception.ClientException;

import java.util.List;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.CompletableFuture;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;

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
    private final ExecutionControl executionControl;
    private final ExecutionRepository executionRepository;
    private final SessionRepository sessionRepository;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ModelContextService modelContextService;
    private final ExecutionIdentity executionIdentity;
    private final ToolCallRepository toolCallRepository;
    private final SessionAttributeRestorer sessionAttributeRestorer;
    /** 已受理上下文的执行协作：模型调用与运行资格收尾都在它那里。 */
    private final PreparedChatExecutor chatExecutor;
    private final ChatTurnService chatTurnService;
    private final ExecutionQueryService executionQueryService;
    /** 重发目标的定位与校验；重发脚本本身只负责顺序。 */
    private final ResendTargetResolver resendTargetResolver;
    /** 重发回滚：把被改写的那条提问及其之后的整段历史从库里作废。 */
    private final ConversationRollbackService conversationRollbackService;

    @Override
    public Result<String> chat(ChatCommand command) {
        RuntimeContext context = requestPreparer.prepare(command);
        ensureSessionTreeIsIdle(context.executionContext().rootSessionId());
        // 单飞校验前置到请求线程，且**先于用户消息落库**：冲突时执行尚未开始，
        // 用户消息也还没写进历史，不会留下「有提问、无执行、无错误」的孤行。
        sseEventPublisher.prepareProjection(context.executionContext().rootSessionId());
        sessionExecutionRegistry.beginRoot(context.executionContext().rootSessionId());
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
        if (sessionId == null) {
            throw new ClientException("会话标识不能为空");
        }
        long rootSessionId = executionIdentity.resolveRootSessionId(sessionId);
        return sseEventPublisher.connect(rootSessionId);
    }

    @Override
    public SseEmitter chatStream(ChatCommand command) {
        // HC-2：先 resolve 出确定的会话身份，再注册运行与订阅事件。
        RuntimeContext context = requestPreparer.prepare(command);   // 内含建会话，sessionId 一定非 null

        // 挂起防护：会话还有挂起中的执行（等待子代理审批 / 人工决策）时不允许开新一轮 ——
        // 否则旧执行的委派槽位永远悬空，审批落定后还会出现两个并发的根执行。
        ensureSessionTreeIsIdle(context.executionContext().rootSessionId());

        // 单飞校验前置：必须在建立 emitter / 订阅事件 / 落库用户消息之前，校验失败直接抛
        // ClientException，不建立任何 SSE 连接；否则第一个请求已建流之后才冲突，语义与体验都不对。
        sseEventPublisher.prepareProjection(context.executionContext().rootSessionId());
        sessionExecutionRegistry.beginRoot(context.executionContext().rootSessionId());

        // 订阅到根会话（HC-3 路由键）：本会话及其全部子会话的运行时事件都归入此流。
        SseEmitter sseEmitter = sseEventPublisher.connect(context.executionContext().rootSessionId());

        CompletableFuture.runAsync(() -> {
            try {
                executePrepared(context);
            } catch (Exception e) {
                log.error("Error during chatStream execution", e);
            } finally {
                // 运行时的终态事件已在 executePrepared 返回前发送。及时结束该请求的流，
                // 避免浏览器结束读取后后端仍保留失效 emitter。
                sseEventPublisher.finish(sseEmitter);
            }
        });
        return sseEmitter;
    }

    /**
     * 重发：按 checkpoint 编辑当时那条提问后重跑一轮，该轮及其之后的历史全部作废。
     *
     * <p>顺序不能动：回滚必须在取到运行资格之后（否则并发重发各砍一遍历史），
     * 且必须在 {@code commitUserMessage} 之前（否则新提问会被自己删掉）。</p>
     */
    @Override
    public SseEmitter resend(ChatCommand command) {
        ResendTarget target = resendTargetResolver.resolve(command);

        // 上下文取目标轮次的历史基线
        RuntimeContext context = requestPreparer.prepareForResend(command, target.baseline());

        long rootSessionId = context.executionContext().rootSessionId();

        ensureSessionTreeIsIdle(rootSessionId);

        sseEventPublisher.prepareProjection(rootSessionId);
        sessionExecutionRegistry.beginRoot(rootSessionId);

        try {
            conversationRollbackService.rollbackBefore(context.executionContext().sessionId(),
                    target.turnId(), target.baseline());
        } catch (RuntimeException e) {
            // 回滚没成功就绝不能往下跑：否则新一轮会接在一段本该消失的历史之上。
            sessionExecutionRegistry.finishRoot(rootSessionId);
            throw e;
        }

        SseEmitter sseEmitter = sseEventPublisher.connect(rootSessionId);
        CompletableFuture.runAsync(() -> {
            try {
                executePrepared(context);
            } catch (Exception e) {
                log.error("Error during resend execution", e);
            } finally {
                sseEventPublisher.finish(sseEmitter);
            }
        });
        return sseEmitter;
    }

    /**
     * 执行档位：团队 > 单 Agent > 裸模型。
     *
     * <p><b>为什么还留着这一层</b>：v1 的 SSE 入口在提交用户消息之后还要把执行结果
     * 交回给请求线程（{@code chat()} 要返回消息内容）。真正的模型调用与收尾已经搬进
     * {@link PreparedChatExecutor}，这里只保留「提交 → 委托 → 返回」三步。</p>
     *
     * <p><b>提交失败必须自己释放运行资格</b>：{@code chatExecutor} 的 {@code finally}
     * 只覆盖它自己被调用的那段，提交抛异常时它根本没进 —— 不在这里补一次释放，
     * 会话会被永久锁死在「执行中」，用户既发不出下一条也看不到任何错误。</p>
     */
    private Execution executePrepared(RuntimeContext context) {
        long rootSessionId = context.executionContext().rootSessionId();
        RuntimeContext committed;
        try {
            // 运行资格已经拿到（调用方在进入本方法前调了 beginRoot），现在才把用户消息落库：
            // 顺序反了就会出现「消息已入库、执行被拒绝」的孤行。
            committed = context.withTurnId(requestPreparer.commitUserMessage(context));
        } catch (RuntimeException commitFailure) {
            sessionExecutionRegistry.finishRoot(rootSessionId);
            throw commitFailure;
        }
        return chatExecutor.run(committed);
    }

    @Override
    public void stop(Long sessionId) {
        Session selected = sessionRepository.findById(sessionId).orElse(null);
        Long rootSessionId = selected != null && selected.isSubSession()
                ? selected.getRootSessionId()
                : sessionId;

        Set<Long> ids = new LinkedHashSet<>();
        ids.add(rootSessionId);
        sessionRepository.findSessionTree(rootSessionId).stream()
                .map(Session::getId)
                .forEach(ids::add);

        List<SessionExecutionRegistry.ChildExecution> liveChildren = sessionExecutionRegistry.cancelRoot(rootSessionId);
        liveChildren.stream().map(SessionExecutionRegistry.ChildExecution::sessionId).forEach(ids::add);
        ids.stream().flatMap(id -> executionIdentity.activeExecutionIds(id).stream())
                .forEach(this::requestCancel);

        liveChildren.forEach(child -> {
            Thread thread = child.thread();
            if (thread != null && thread != Thread.currentThread()) thread.interrupt();
        });
    }

    @Override
    public void suspend(Long sessionId) {
        if (sessionId == null) return;
        executionIdentity.activeExecutionIds(sessionId).forEach(executionControl::suspend);
    }

    @Override
    public synchronized Result<String> resume(Long sessionId) {
        String id = executionIdentity.latestSuspendedExecutionId(sessionId);
        if (id == null) {
            throw new ClientException("该会话没有可恢复的执行");
        }

        // 未决卡片（pending PROMISE）优先：必须先经 /tool-call/decide 处理，再恢复。
        throwIf(!toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(id)).isEmpty(), "请先处理待审批事项");

        // 用 resume(Execution) 把实例直接交给 loop；resume(String) 是副本，禁用。
        Execution execution = executionRepository.findById(id)
                .orElseThrow(() -> new ClientException("执行不存在: " + id));

        throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, "执行不可以恢复");


        // 恢复不经过 RequestPreparer，会话级业务属性不会被重新下发，必须先补齐再交给 loop。
        sessionAttributeRestorer.restore(execution, sessionId);
        sseEventPublisher.prepareProjection(executionIdentity.resolveRootSessionId(sessionId));

        // 交接通知由框架发布：resume(Execution) 内部触发 RuntimeLifeStyleManager#onResume，
        Execution resumed = executionControl.resume(execution);

        modelContextService.replace(sessionId, resumed.getMessages());

        return Result.success(resumed.getMessages().toString());
    }

    private void requestCancel(String executionId) {
        try {
            executionControl.cancel(executionId);
        } catch (IllegalStateException ignored) {
            // A session tree contains historical executions as well as the currently active ones.
        }
    }

    /**
     * 会话空闲防护：会话下任一执行尚未终结（{@code CREATED} / {@code RUNNING} / {@code SUSPENDED}）
     * 就拒绝开新一轮。恢复入口是审批卡片与 {@code /resume}，不是再发一条消息。
     *
     * <p><b>三个状态都要拦，缺一不可</b>：{@code SUSPENDED}（等待审批 / 子代理回填）自不必说；
     * {@code CREATED} / {@code RUNNING} 是<b>恢复执行</b>在跑 —— 恢复由
     * {@code DelegationBackfillListener} 与 {@code /resume} 直接交给 loop，不经过请求线程，
     * {@link SessionExecutionRegistry#beginRoot} 那把单飞锁在挂起时就已释放。只查 SUSPENDED
     * 会漏掉「挂起 → 子代理回填 → 已恢复并正在跑」这段窗口，用户于是能在同一会话里开出第二个
     * 根执行：线上事故里两条「继续推进」各跑出一份交付总结，前端两个气泡同时收事件。</p>
     */
    private void ensureSessionTreeIsIdle(long rootSessionId) {
        List<ExecutionState> states = executionQueryService.latestStatesBySession(List.of(rootSessionId))
                .get(rootSessionId);
        if (states == null || states.isEmpty()) {
            return;
        }

        throwIf(states.contains(ExecutionState.SUSPENDED), "会话有等待恢复的执行，请先处理待审批事项或恢复执行");
        throwIf(states.stream().anyMatch(state -> !state.isTerminal()),
                "该会话正在执行中，请等待本轮结束或先停止");
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

}
