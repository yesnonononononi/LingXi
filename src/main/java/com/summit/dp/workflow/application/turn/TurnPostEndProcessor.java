package com.summit.dp.workflow.application.turn;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.List;

/**
 * 轮次结束事件的派发器：按 {@code order()} 升序串行调用，单个失败只记日志。
 *
 * <p>为什么吞异常：它跑在**已经完成**的轮次之后。一次成功的执行不该因为某个后置动作
 * 崩了而被反噬成失败 —— 那会让用户在历史里看到一条「失败」但其实回答已经生成。</p>
 *
 * <p>用 {@link ObjectProvider} 取监听器而不是直接注入 {@code List}：待发送队列那条链会
 * 反向依赖执行器（派发要提交新执行），直接注入会构成启动期循环依赖。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class TurnPostEndProcessor {

    private final ObjectProvider<TurnPostEndListener> listeners;

    public void publish(TurnPostEndContext context) {
        if (context == null) {
            return;
        }
        List<TurnPostEndListener> ordered = listeners.orderedStream()
                .sorted(Comparator.comparingInt(TurnPostEndListener::order))
                .toList();
        for (TurnPostEndListener listener : ordered) {
            try {
                listener.onTurnEnded(context);
            } catch (RuntimeException | LinkageError failure) {
                log.error("轮次结束后置处理失败: listener={}, sessionId={}, executionId={}",
                        listener.getClass().getSimpleName(), context.sessionId(), context.executionId(), failure);
            }
        }
    }
}
