package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.shared.exception.ClientException;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.CompletableFuture;
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
    private final AgentWorkflowOrchestrator agentWorkflowOrchestrator;
    private final ExecutionControl executionControl;
    private final ExecutionRepository executionRepository;
    private final SessionRepository sessionRepository;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ModelContextService modelContextService;
    private final ExecutionIdentity executionIdentity;
    private final ToolCallRepository toolCallRepository;
    private final SessionAttributeRestorer sessionAttributeRestorer;

    @Override
    public Result<String> chat(ChatCommand command) {
        RuntimeContext context = requestPreparer.prepare(command);
        // 单飞校验前置到请求线程：冲突时在执行开始前立即失败，不写任何会话状态。
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
        long rootSessionId = executionIdentity.rootSessionIdOfSession(sessionId);
        return sseEventPublisher.connect(rootSessionId);
    }

    @Override
    public SseEmitter chatStream(ChatCommand command) {
        // HC-2：先 resolve 出确定的会话身份，再注册运行与订阅事件。
        RuntimeContext context = requestPreparer.prepare(command);   // 内含建会话，sessionId 一定非 null

        // 单飞校验前置：必须在建立 emitter / 订阅事件之前，校验失败直接抛 ClientException，
        // 不建立任何 SSE 连接；否则第一个请求已建流之后才冲突，语义与体验都不对。
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
                sseEmitter.complete();
            }
        });
        return sseEmitter;
    }

    /**
     * 执行档位：团队 > 单 Agent > 裸模型。
     * 请求只带 agentId 时按该 Agent 的人设与工具清单直聊；两者都没有时才退回全局系统提示词。
     *
     * <p><b>说明</b>：{@code beginRoot} 已前移到请求线程（chat / chatStream 各自在进入本方法前调用），
     * 本方法只负责执行与收尾。{@code finally} 中只保留 {@code finishRoot} 运行注册收尾——
     * 会话不再持有执行状态，过程状态唯一归属 execution 表。</p>
     */
    private Execution executePrepared(RuntimeContext context) {
        long rootSessionId = context.executionContext().rootSessionId();
        Execution execution;
        try {
            if (context.teamId() != null) {
                execution = agentWorkflowOrchestrator.executeWorkflow(context.teamId(), context);
            } else if (context.agentId() != null) {
                execution = agentWorkflowOrchestrator.executeSingleAgent(context.agentId(), context);
            } else {
                execution = agentWorkflowOrchestrator.executeDefaultAgent(context);
            }
            modelContextService.replace(ExecutionIdentity.sessionId(execution), execution.getMessages());
            return execution;
        } finally {
            sessionExecutionRegistry.finishRoot(rootSessionId);
        }
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
    public Result<String> resume(Long sessionId) {
        String id = executionIdentity.latestSuspendedExecutionId(sessionId);
        // 未决卡片（pending PROMISE）优先：必须先经 /tool-call/decide 处理，再恢复。
        if (!toolCallRepository.listPendingByExecutionId(Long.valueOf(id)).isEmpty()) {
            throw new ClientException("请先处理待审批事项");
        }
        // 用 resume(Execution) 把实例直接交给 loop；resume(String) 是副本，禁用。
        Execution execution = executionRepository.findById(id)
                .orElseThrow(() -> new ClientException("执行不存在: " + id));
        // 恢复不经过 RequestPreparer，会话级业务属性不会被重新下发，必须先补齐再交给 loop。
        sessionAttributeRestorer.restore(execution, sessionId);
        // 交接通知由框架发布：resume(Execution) 内部触发 RuntimeLifeStyleManager#onResume，
        // 该回调早于模型调用发出 EXECUTION_RESUMED，前端据此把会话切回执行态。
        // 应用层因此不再自行发布恢复事件（此前自造的 ExecutionResumedEventPublisher 已移除）。
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

}
