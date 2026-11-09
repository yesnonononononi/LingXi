package com.summit.dp.device.interfaces.ws;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PendingResponsesTest {

    private static WireMessage message(String type, String id) {
        return new WireMessage(1, type, id, "dev-1", 1, 0, JsonNodeFactory.instance.objectNode());
    }

    @Test
    void 响应能唤醒等待者() throws Exception {
        PendingResponses pending = new PendingResponses();
        CompletableFuture<WireMessage> future = pending.register("ob-1");

        pending.complete("ob-1", message("observe_result", "m-2"));

        WireMessage result = pending.await("ob-1", future, Duration.ofSeconds(1));
        assertEquals("observe_result", result.type());
        assertEquals(0, pending.size(), "完成后必须从等待表移除，否则内存只增不减");
    }

    @Test
    void 超时要抛异常而不是返回null() {
        PendingResponses pending = new PendingResponses();
        CompletableFuture<WireMessage> future = pending.register("ob-2");

        // 调用方必须能区分「没等到」和「等到了空」——两者处置方式相反
        assertThrows(TimeoutException.class,
                () -> pending.await("ob-2", future, Duration.ofMillis(30)));
        assertEquals(0, pending.size(), "超时后要清理，避免后续响应串到已废弃的请求上");
    }

    @Test
    void 关联标识重复登记直接暴露缺陷() {
        PendingResponses pending = new PendingResponses();
        pending.register("a-1");

        assertThrows(IllegalStateException.class, () -> pending.register("a-1"));
    }

    @Test
    void 无人在等的响应被静默丢弃() {
        PendingResponses pending = new PendingResponses();

        // 迟到结果不该抛异常打断接收循环
        pending.complete("ob-ghost", message("observe_result", "m-9"));

        assertEquals(0, pending.size());
    }

    @Test
    void 断线时所有等待者立即失败() {
        PendingResponses pending = new PendingResponses();
        CompletableFuture<WireMessage> future = pending.register("a-2");

        pending.failAll("连接已关闭");

        assertTrue(future.isCompletedExceptionally(), "不能干等到超时（最坏 20 秒）");
        assertEquals(0, pending.size());
    }
}
