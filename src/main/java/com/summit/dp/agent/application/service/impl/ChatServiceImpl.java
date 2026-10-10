package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver.ResendTarget;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
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
        ensureRootExecutionIdle(context.executionContext().rootSessionId());
        // 单飞校验前置到请求线程，且**先于用户消息落库**：冲突时执行尚未开始，
        // 用户消息也还没写进历史，不会留下「有提问、无执行、无错误」的孤行。
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
        // 入口校验：0 是「自身即根」的哨兵（Session.ROOT_SESSION_ID），不是合法会话主键。
        // 非正数必须在这里拒成业务错误，否则会落进 resolveRootSessionId 抛
        // IllegalStateException → 兜底 handler 报 HTTP 500「系统繁忙」。
        throwIf(sessionId == null || sessionId <= 0, "会话标识不合法");
        long rootSessionId = executionIdentity.resolveRootSessionId(sessionId);
        return sseEventPublisher.connect(rootSessionId);
    }

    /**
     * 受理一次聊天请求：请求线程同步落库，模型调用异步，不建立 emitter。
     *
     * <p>顺序与 {@link #chat} 一致，只把「提交用户消息」放在返回之前：
     * prepare 解析会话 → 单飞校验 → 取运行资格 → <b>在请求线程同事务落库并拿到 turnId</b>
     * → 异步只跑模型。这样「受理返回成功」就有明确的落库依据，turnId 也已产生并随响应返回；
     * 事件一律由会话级订阅承载，这条入口不建流、不订阅。</p>
     */
    @Override
    public Result<ChatAcceptanceVO> acceptCommand(ChatCommand command) {
        RuntimeContext context = requestPreparer.prepare(command);
        ensureRootExecutionIdle(context.executionContext().rootSessionId());
        sessionExecutionRegistry.beginRoot(context.executionContext().rootSessionId());
        return Result.success(commitAndSubmit(context));
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

        ensureRootExecutionIdle(rootSessionId);

        sessionExecutionRegistry.beginRoot(rootSessionId);

        try {
            conversationRollbackService.rollbackBefore(context.executionContext().sessionId(),
                    target.turnId(), target.baseline());
        } catch (RuntimeException e) {
            // 回滚没成功就绝不能往下跑：否则新一轮会接在一段本该消失的历史之上。
            sessionExecutionRegistry.finishRoot(rootSessionId);
            throw e;
        }

        return Result.success(commitAndSubmit(context));
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
     * <p>三个入口（{@code chat} / {@code acceptCommand} / {@code resend}）都经这里，
     * 受理流程只在这一处收口。事务边界在被调方（{@code PreparedChatExecutor#admit}）—— 本方法是
     * 私有自调用，事务注解挂在这里不会生效。</p>
     *
     * <p><b>提交失败必须自己释放运行资格</b>：{@code chatExecutor} 的收尾只在它被调用之后生效，
     * 提交抛异常时它根本没进 —— 不在这里补一次释放，会话会被永久锁死在「执行中」，
     * 用户既发不出下一条也看不到任何错误。</p>
     */
    private RuntimeContext commitUserMessage(RuntimeContext context) {
        try {
            return chatExecutor.admit(context);
        } catch (RuntimeException commitFailure) {
            sessionExecutionRegistry.finishRoot(context.executionContext().rootSessionId());
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

        // 不关流：会话流是会话级资源，生命周期跟页面挂载 / 卸载走。停止只取消执行 ——
        // 一旦在这里断开，前端下一次发送前就必须重新挂载，否则那段时间的事件无处可去。
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

        // 交接通知由框架发布：resume(Execution) 内部触发 RuntimeLifeStyleManager#onResume，
        Execution resumed = executionControl.resume(execution);

        modelContextService.replace(sessionId, resumed.getMessages());

        return Result.success(resumed.getMessages().toString());
    }

    private void requestCancel(String executionId) {
        try {
            executionControl.cancel(executionId);
        } catch (IllegalStateException ignored) {
            // 会话树里既有历史执行，也有当前活跃的执行，取消时命中已终结的执行属正常情况。
        }
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
