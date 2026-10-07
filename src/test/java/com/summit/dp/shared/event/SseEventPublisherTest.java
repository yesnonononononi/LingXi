package com.summit.dp.shared.event;

import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.ContextUpdateEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;

/**
 * SSE 双连接与空桶回收回归：守住 {@code SseEventPublisher#connect} 的
 * compute 原子移除语义——断开回调只回收空桶，绝不能把仍有活跃流的桶连带删掉
 * （否则后续 publish 会静默丢事件）；全部断开后注册表必须清零；重复移除幂等。
 *
 * <p>回调由容器在真实断开时触发；单测经 {@code newEmitter()} 工厂注入 mock，
 * 用 ArgumentCaptor 捕获注册的 Runnable 手动触发，不依赖真实容器。</p>
 */
class SseEventPublisherTest {

    private SseEventPublisher publisher;
    private final List<SseEmitter> created = new ArrayList<>();

    /** 推送用的最小事件：真实框架事件，避免依赖字符串载荷。 */
    private static AgentEvent sampleEvent() {
        return new ContextUpdateEvent("exec-test", ContextUpdateEvent.Phase.UPDATE, null, "test");
    }

    @BeforeEach
    void setup() {
        publisher = new SseEventPublisher() {
            @Override
            protected SseEmitter newEmitter() {
                SseEmitter emitter = mock(SseEmitter.class);
                created.add(emitter);
                return emitter;
            }
        };
    }

    @AfterEach
    void shutdown() {
        publisher.close();
        created.clear();
    }

    @Test
    @DisplayName("双连接：一端完成回调后，另一端 publish 仍可达（空桶不误删）")
    void completionOfOneKeepsOtherPublishable() throws java.io.IOException {
        publisher.connect(1L);
        publisher.connect(1L);
        SseEmitter first = created.get(0);
        SseEmitter second = created.get(1);

        ArgumentCaptor<Runnable> captor = ArgumentCaptor.forClass(Runnable.class);
        verify(first).onCompletion(captor.capture());
        // 等价于容器触发第一端的断开完成回调
        captor.getValue().run();

        publisher.publish(1L, sampleEvent());

        // 每条流连接时都会先收到一帧 READY；这里关心的是业务事件只投给了仍挂着的第二条。
        verify(second, timeout(3000).times(2)).send(any(SseEmitter.SseEventBuilder.class));
        verify(first, times(1)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    @DisplayName("全部断开后 connectedCount 回到 0；断开一半时仍计 1")
    void allDisconnectedResetsRootCount() {
        publisher.connect(1L);
        publisher.connect(2L);
        assertEquals(2, publisher.connectedCount());

        ArgumentCaptor<Runnable> firstDone = ArgumentCaptor.forClass(Runnable.class);
        verify(created.get(0)).onCompletion(firstDone.capture());
        firstDone.getValue().run();
        assertEquals(1, publisher.connectedCount());

        ArgumentCaptor<Runnable> secondDone = ArgumentCaptor.forClass(Runnable.class);
        verify(created.get(1)).onCompletion(secondDone.capture());
        secondDone.getValue().run();
        assertEquals(0, publisher.connectedCount());
    }

    @Test
    @DisplayName("幂等：单 emitter 完成后重复触发移除不抛异常")
    void repeatedRemovalIsIdempotent() {
        publisher.connect(7L);
        ArgumentCaptor<Runnable> captor = ArgumentCaptor.forClass(Runnable.class);
        verify(created.get(0)).onCompletion(captor.capture());
        Runnable remove = captor.getValue();

        // 容器可能相继触发 completion / error 回调，重复移除必须无害
        assertDoesNotThrow(() -> {
            remove.run();
            remove.run();
        });
        assertEquals(0, publisher.connectedCount());
    }

    // --- 客户端断开：写不出去不是故障，但也不能留着每轮重试 ----------------------------------

    /**
     * 真实故障背景：执行终态事件先于收尾的用量推送发出，前端看到终态就关流，于是每轮都有一条
     * 推送写到已断开的流上（{@code AsyncRequestNotUsableException} 继承 IOException）。此前它被
     * 打成 WARN + 完整堆栈，每轮刷一条假告警。
     */
    @Test
    @DisplayName("推送写不出去：不抛异常，并摘掉该流而不是留着每轮重试")
    void unwritableStreamIsDroppedInsteadOfRetried() throws java.io.IOException {
        publisher.connect(1L);
        SseEmitter dead = created.get(0);
        doThrow(new java.io.IOException("你的主机中的软件中止了一个已建立的连接。"))
                .when(dead).send(any(SseEmitter.SseEventBuilder.class));

        assertDoesNotThrow(() -> publisher.publish(1L, sampleEvent()));
        verify(dead, timeout(3000)).completeWithError(any());
        assertEquals(0, publisher.connectedCount(), "写失败的流必须被摘掉");

        publisher.publish(1L, sampleEvent());
        // 连接时的 READY + 写失败的那次业务推送；摘流之后不再重试。
        verify(dead, times(2)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    @DisplayName("一条流写失败不影响同会话的其他流")
    void oneDeadStreamDoesNotBlockItsSiblings() throws java.io.IOException {
        publisher.connect(1L);
        publisher.connect(1L);
        SseEmitter dead = created.get(0);
        SseEmitter alive = created.get(1);
        doThrow(new java.io.IOException("client gone"))
                .when(dead).send(any(SseEmitter.SseEventBuilder.class));

        publisher.publish(1L, sampleEvent());

        // 每条流连接时先收到 READY，因此这里是 2 次（READY + 本次业务事件）。
        verify(alive, timeout(3000).times(2)).send(any(SseEmitter.SseEventBuilder.class));
        verify(dead, timeout(3000)).completeWithError(any());
        assertEquals(1, publisher.connectedCount(), "只摘掉写不出去的那一条");
    }

    // --- 就绪握手与心跳：传输层信号，不是框架业务事件 ---------------------------------------

    /**
     * READY 的顺序是可观测契约：客户端收到 READY 即代表 emitter 已在桶里，此前的「等 READY
     * 再提交发送」才不丢事件。断言的必须是「READY 发出时 connectedCount 已为 1」这种顺序事实，
     * 而不是「发过 READY」—— 后者永远为真，抓不住把 READY 挪到注册之前的回归。
     */
    @Test
    @DisplayName("READY 必须在 emitter 注册进桶之后发出（顺序断言，非「发过 READY」）")
    void readySentOnlyAfterEmitterRegistered() {
        List<Integer> connectedCountAtSend = new ArrayList<>();
        List<SseEmitter.SseEventBuilder> sentBuilders = new ArrayList<>();
        SseEventPublisher readyPublisher = new SseEventPublisher() {
            @Override
            protected SseEmitter newEmitter() {
                SseEmitter emitter = mock(SseEmitter.class);
                try {
                    doAnswer(invocation -> {
                        // 记录「发送的那一刻」注册表里已有多少条流：顺序反了这里就是 0。
                        connectedCountAtSend.add(connectedCount());
                        sentBuilders.add(invocation.getArgument(0));
                        return null;
                    }).when(emitter).send(any(SseEmitter.SseEventBuilder.class));
                } catch (java.io.IOException e) {
                    throw new IllegalStateException(e);
                }
                created.add(emitter);
                return emitter;
            }
        };
        try {
            readyPublisher.connect(42L);

            assertEquals(1, connectedCountAtSend.size(), "connect 必须发出一帧就绪信号");
            assertEquals(1, connectedCountAtSend.get(0),
                    "READY 发出时 emitter 必须已经在桶里（挪到注册之前就会变成 0）");
            assertTrue(renderWire(sentBuilders.get(0)).contains("event:READY"),
                    "就绪信号必须是命名事件 READY，而不是被客户端忽略的注释");
        } finally {
            readyPublisher.close();
        }
    }

    /**
     * 心跳必须是带 name 与 data 的命名事件：注释行按 SSE 规范会被客户端忽略，EventSource 也不暴露
     * 任何读取 API —— 用注释做心跳，客户端只能靠连接没被回收来猜，等于完全观测不到。
     */
    @Test
    @DisplayName("心跳是带 name/data 的命名事件，不是被忽略的 comment")
    void heartbeatIsNamedEventWithDataNotComment() throws java.io.IOException {
        publisher.connect(1L);
        SseEmitter emitter = created.get(0);
        // 屏蔽连接时的 READY，只观察心跳这一帧。
        clearInvocations(emitter);

        publisher.heartbeat();

        ArgumentCaptor<SseEmitter.SseEventBuilder> captor =
                ArgumentCaptor.forClass(SseEmitter.SseEventBuilder.class);
        verify(emitter).send(captor.capture());
        String wire = renderWire(captor.getValue());
        assertTrue(wire.contains("event:HEARTBEAT"), "心跳必须带事件名，不能退化成会被忽略的注释行");
        assertTrue(wire.contains("data:"), "心跳必须带 data，否则客户端读不到任何东西");
        assertFalse(wire.startsWith(":"), "注释行以冒号开头；心跳若还是注释，这里会命中");
    }

    /** 把 builder 渲染成接近 SSE 线格式的文本，用于断言事件名与 data 字段（字段名是协议规定的）。 */
    private static String renderWire(SseEmitter.SseEventBuilder builder) {
        StringBuilder text = new StringBuilder();
        for (SseEmitter.DataWithMediaType item : builder.build()) {
            text.append(item.getData());
        }
        return text.toString();
    }

}
