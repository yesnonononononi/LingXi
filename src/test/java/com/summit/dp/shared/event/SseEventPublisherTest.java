package com.summit.dp.shared.event;

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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
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

        publisher.publish(1L, "{\"type\":\"TEST\"}");

        verify(second, times(1)).send(any(SseEmitter.SseEventBuilder.class));
        verify(first, never()).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    @DisplayName("全部断开后 connectedRootCount 回到 0；断开一半时仍计 1")
    void allDisconnectedResetsRootCount() {
        publisher.connect(1L);
        publisher.connect(2L);
        assertEquals(2, publisher.connectedRootCount());

        ArgumentCaptor<Runnable> firstDone = ArgumentCaptor.forClass(Runnable.class);
        verify(created.get(0)).onCompletion(firstDone.capture());
        firstDone.getValue().run();
        assertEquals(1, publisher.connectedRootCount());

        ArgumentCaptor<Runnable> secondDone = ArgumentCaptor.forClass(Runnable.class);
        verify(created.get(1)).onCompletion(secondDone.capture());
        secondDone.getValue().run();
        assertEquals(0, publisher.connectedRootCount());
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
        assertEquals(0, publisher.connectedRootCount());
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

        assertDoesNotThrow(() -> publisher.publish(1L, "{\"type\":\"CONTEXT_UPDATE\"}"));
        assertEquals(0, publisher.connectedRootCount(), "写失败的流必须被摘掉");

        publisher.publish(1L, "{\"type\":\"CONTEXT_UPDATE\"}");
        verify(dead, times(1)).send(any(SseEmitter.SseEventBuilder.class));
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

        publisher.publish(1L, "{\"type\":\"CONTEXT_UPDATE\"}");

        verify(alive, times(1)).send(any(SseEmitter.SseEventBuilder.class));
        assertEquals(1, publisher.connectedRootCount(), "只摘掉写不出去的那一条");
    }

}
