package com.summit.dp.stream;

import com.summit.dp.stream.infrastructure.transport.StreamSubscription;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.Executor;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class StreamSubscriptionTest {
    @Test void overflowClosesWithoutSendingPartialQueueOrBlockingAnotherConnection() throws Exception {
        Queue<Runnable> tasks = new ArrayDeque<>();
        Executor sender = tasks::add;
        SseEmitter slow = mock(SseEmitter.class);
        Runnable remove = mock(Runnable.class);
        StreamSubscription subscription = new StreamSubscription(slow, sender, 2, remove);
        assertTrue(subscription.offer(SseEmitter.event().data("one")));
        assertTrue(subscription.offer(SseEmitter.event().data("two")));
        assertFalse(subscription.offer(SseEmitter.event().data("overflow")));
        assertFalse(subscription.offer(SseEmitter.event().data("after-gap")));
        SseEmitter fast = mock(SseEmitter.class);
        StreamSubscription other = new StreamSubscription(fast, sender, 2, () -> {});
        assertTrue(other.offer(SseEmitter.event().data("complete-event")));
        while (!tasks.isEmpty()) tasks.remove().run();
        verify(slow, never()).send(any(SseEmitter.SseEventBuilder.class));
        verify(slow).completeWithError(any()); verify(remove).run();
        verify(fast).send(any(SseEmitter.SseEventBuilder.class));
    }
    @Test void aSingleOversizedFrameAlsoRequiresResynchronization() {
        Queue<Runnable> tasks = new ArrayDeque<>();
        StreamSubscription subscription = new StreamSubscription(mock(SseEmitter.class), tasks::add, 256, () -> {});
        assertFalse(subscription.offer(SseEmitter.event().data("a".repeat(9 * 1024 * 1024))));
    }
    @Test void legacyRequestCompletesOnlyAfterAllAcceptedFramesHaveBeenSent() throws Exception {
        Queue<Runnable> tasks = new ArrayDeque<>();
        SseEmitter emitter = mock(SseEmitter.class);
        StreamSubscription subscription = new StreamSubscription(emitter, tasks::add, 2, () -> {});
        subscription.offer(SseEmitter.event().data("answer"));
        subscription.offer(SseEmitter.event().data("terminal"));
        subscription.finish(); verify(emitter, never()).complete();
        while (!tasks.isEmpty()) tasks.remove().run();
        InOrder order = inOrder(emitter);
        order.verify(emitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        order.verify(emitter).complete();
    }
}
