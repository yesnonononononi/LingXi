package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.runtime.loop.lifestyle.RuntimeLifeStyleManager;
import com.summit.runtime.loop.lifeStyle.DefaultRuntimeLifeStyleManager;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ModelContextService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 执行终态生命周期装饰器：在框架默认行为之外，把失败执行已产生的消息回写模型上下文。
 *
 * <p>背景：{@code RuntimeProcessorTemplate.process} 的 catch 块先调用
 * {@code runtimeLifeStyleManager.onError(execution, e)}、再包装异常上抛——身份在
 * {@code throw} 那一行之后才被抹掉。此处是应用侧最后一次握有完整 {@link Execution}
 *（消息全量、状态刚置 FAILED、早于 finally 的 save/unregister）的同步点，
 * 直接用内存对象恢复，无需按会话反查执行、无需解码快照。</p>
 *
 * <p>若不回写，本轮已产生的消息（含工具调用/文件编辑）不会进入下一轮上下文，
 * 模型会"失忆"并否认自己刚做过的工作。子执行失败时各自按自身会话恢复，
 * 不会像"会话→最近执行"反查那样把子执行快照错写进根会话。</p>
 *
 * <p>恢复失败绝不掩盖原始异常：任何一步出错都只记日志后放弃，异常仍走框架默认
 * 流程上抛。框架装配处 {@code @ConditionalOnMissingBean} 保证本 bean 声明后
 * {@link DefaultRuntimeLifeStyleManager} 不再创建，行为由委托链保留。</p>
 */
@Slf4j
@Component
public class ContextRecoveringLifeStyleManager implements RuntimeLifeStyleManager {

    private static final String INTERRUPTION_NOTE = """
            The previous execution was interrupted before completion by a transient failure; \
            all progress and tool work above are preserved.""";

    private final RuntimeLifeStyleManager delegate;
    private final ModelContextService modelContextService;

    public ContextRecoveringLifeStyleManager(RuntimeEventPublisher runtimeEventPublisher,
                                             ModelContextService modelContextService) {
        this.delegate = new DefaultRuntimeLifeStyleManager(runtimeEventPublisher);
        this.modelContextService = modelContextService;
    }

    @Override
    public void onError(Execution execution, Exception e) {
        recoverModelContext(execution, e);
        delegate.onError(execution, e);
    }

    /**
     * 把失败执行的内存消息回写模型上下文，并追加一条 SYSTEM 中断说明。
     *
     * <p>此刻 loop 尚未收尾（{@code List.copyOf} 归一化发生在 finally），消息是最完整的；
     * 回写只写 session_context，不改写 execution 自身——失败执行不会被 resume，
     * 快照与上下文的这条差异没有实际影响。</p>
     */
    private void recoverModelContext(Execution execution, Exception cause) {
        try {
            long sessionId = ExecutionIdentity.sessionId(execution);
            List<Message> messages = execution.getMessages();
            if (messages == null || messages.isEmpty()) {
                log.warn("【chat】execution failed before any message was produced, nothing to recover, "
                        + "sessionId={}, executionId={}", sessionId, execution.getId());
                return;
            }
            List<Message> recovered = new ArrayList<>(messages);
            recovered.add(SystemMessageEntity.builder().text(INTERRUPTION_NOTE).build());
            modelContextService.replace(sessionId, recovered);
            log.warn("【chat】execution failed, recovered {} message(s) into model context, "
                            + "sessionId={}, executionId={}, cause={}",
                    recovered.size(), sessionId, execution.getId(), cause.toString());
        } catch (Exception recoveryError) {
            log.warn("【chat】failed to recover model context after execution failure, executionId={}, cause={}",
                    execution.getId(), recoveryError.toString());
        }
    }

    @Override
    public void onStart(Execution execution) {
        delegate.onStart(execution);
    }

    @Override
    public void onCancel(Execution execution) {
        delegate.onCancel(execution);
    }

    @Override
    public void onSuspend(Execution execution) {
        delegate.onSuspend(execution);
    }

    @Override
    public void onComplete(Execution execution) {
        delegate.onComplete(execution);
    }

    @Override
    public void onResume(Execution snapshot) {
        delegate.onResume(snapshot);
    }
}
