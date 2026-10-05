package com.summit.dp.stream.infrastructure;

import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * 每轮模型调用前，无条件为本次响应生成一个新的 {@code streamKey} 写回执行请求的事件元数据，
 * 作为该轮响应的稳定身份（前端据它把增量、定稿与持久化后的历史行认成同一条回答），
 * 并立即直投一帧 {@code RESPONSE_STARTED} 声明本次响应身份。
 *
 * <p><b>为什么用元数据快照而不是共享投影</b>：{@code AgentRuntimeParameters} 的
 * get/set 都走 {@code Map.copyOf}，{@code set} 换的是新引用；本钩子读出现有元数据、复制出新
 * Map、写入 {@code streamKey} 后再 {@code set} 回去，于是<b>此前已构造出的下游对象看不到这次
 * 写回</b>。一次调用内只生成一个键、只写一次，同一轮的所有读者拿到的是同一个值；
 * 下一轮再调用时新键覆盖旧键，旧键不受影响 —— 这正是「下一轮换身份不改变本轮归属」的依据。</p>
 *
 * <p><b>零 SQL</b>：身份全部来自执行请求已有的元数据快照（rootSessionId/sessionId/turnId/
 * historyRevision 在第 1 步已写入），不查执行表、不查会话表。</p>
 *
 * <p><b>发帧失败<b>不</b>让整轮失败</b>：直投是旁路动作，SSE 是尽力而为的推送通道，前端有
 * bootstrap 兜底；一帧 {@code RESPONSE_STARTED} 丢了，前端仍能在收到 delta 时按 bootstrap
 * 未命中而标 incompleteUntilFinalized，不会算错数据。因此发帧单独 try/catch，异常只记 error，
 * <b>不</b>改 {@link #catchErr()}（它守住的是「身份写入失败必须上抛」，两者语义不同）。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StreamResponseIdentityInterceptor implements LoopInterceptor {

    private final EventStreamPublisher publisher;

    /**
     * 排最前：响应身份必须在任何读取元数据的下游之前就绪 —— 晚一步写入，
     * 本轮的首个增量就会带着上一轮的身份到达，前端只能等下一次校准才纠正归属。
     * 框架的 {@code DefaultLoopInterceptor} 取 {@code Integer.MIN_VALUE}，它只做信号与预算判定、
     * 不写身份；本值取 -900 已排在框架之后、业务侧其余实现之前。
     */
    @Override
    public int order() {
        return -900;
    }

    /**
     * 身份写入失败必须让整轮失败。{@code streamKey} 缺失会让本轮所有事件无归属，
     * 前端只会一直空等或错认成上一轮，比直接报错更难排查，所以不能吃异常。
     *
     * <p>注意本返回值只覆盖下方的身份写入；{@code RESPONSE_STARTED} 发帧失败在方法内部自行吞掉，
     * 两者不是同一件事（见类注释）。</p>
     */
    @Override
    public boolean catchErr() {
        return false;
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        AgentRuntimeParameters parameters = context.execution().getAgentRequest().runtimeParametersOrDefault();
        // 先在不可变快照上复制出新 Map 再写键：直接改原 Map 会被 getEventMetaData 的 Map.copyOf 语义挡掉，
        // 且会波及此前读者。新 Map 只加/覆盖 streamKey，其余身份字段原样保留。
        Map<String, Object> metadata = new HashMap<>(parameters.getEventMetaData());
        String streamKey = String.valueOf(IdUtil.getSnowflakeNextId());
        metadata.put(ExecutionEventMetadata.STREAM_KEY, streamKey);
        Map<String, Object> snapshot = Map.copyOf(metadata);
        parameters.setEventMetaData(snapshot);

        publishResponseStarted(context, snapshot, streamKey);
        return InterceptorResult.NONE;
    }

    /**
     * 直投 {@code RESPONSE_STARTED}，声明本次响应身份。
     *
     * <p>失败只记 error：发帧是旁路，不能让「模型调用前的身份声明」这一帧的丢失拖垮整轮执行。</p>
     */
    private void publishResponseStarted(LoopContext context, Map<String, Object> metadata, String streamKey) {
        try {
            Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(metadata);
            if (rootSessionId == null) {
                // 归属未知就不发送：不得退回全局广播，跨会话泄露不可接受（§3 末段：不查库、不猜归属）。
                log.warn("响应身份缺少根会话，跳过 RESPONSE_STARTED: executionId={}", context.execution().getId());
                return;
            }
            StreamV3Event.Identity identity = new StreamV3Event.Identity(
                    String.valueOf(rootSessionId),
                    text(metadata, ExecutionEventMetadata.SESSION_ID),
                    text(metadata, ExecutionEventMetadata.TURN_ID),
                    context.execution().getId(),
                    text(metadata, ExecutionEventMetadata.HISTORY_REVISION),
                    streamKey);
            StreamV3Event event = StreamV3Event.of(String.valueOf(IdUtil.getSnowflakeNextId()), identity,
                    StreamV3EventType.RESPONSE_STARTED, Instant.now(),
                    new StreamV3Payloads.ResponseStarted(streamKey, null));
            publisher.publish(rootSessionId, event);
        } catch (RuntimeException error) {
            log.error("发布 RESPONSE_STARTED 失败: executionId={}, error={}",
                    context.execution().getId(), error.toString());
        }
    }

    /** 读元数据字符串值；缺失返回 {@code null}。 */
    private static String text(Map<String, Object> metadata, String key) {
        Object value = metadata.get(key);
        return value == null ? null : value.toString();
    }
}
