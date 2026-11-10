package com.summit.dp.workflow.application.chat;

import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.UUID;

/** 单进程队列按会话隔离，优先级由服务端受理顺序决定。 */
@Component
public class PendingChatQueue {
    public record Ticket(String id, long sequence, ChatCommand command) {}

    public record Entry(String id, String input, boolean dispatching) {}

    public record Snapshot(boolean paused, String failure, List<Entry> entries) {}

    private static final class SessionQueue {
        private final PriorityQueue<Ticket> entries = new PriorityQueue<>(ORDER);
        private Ticket claimed;
        private Long deferredExecutionId;
        private boolean paused;
        private String failure;

        private boolean canDispatch() {
            return !paused && claimed == null && !entries.isEmpty();
        }
    }


    private static final int SESSION_LIMIT = 10;
    private static final int PROCESS_LIMIT = 100;
    private static final int TEXT_LIMIT = 100_000;
    private static final Comparator<Ticket> ORDER = Comparator.comparingLong(Ticket::sequence);

    private final Map<Long, SessionQueue> queues = new HashMap<>();
    private long sequence;
    private int total;

    public synchronized String enqueue(long sessionId, ChatCommand command) {
        throwIf(command.input() == null || command.input().isBlank(), "待发送内容不能为空");
        throwIf(command.input().length() > TEXT_LIMIT, "待发送内容最多支持 " + TEXT_LIMIT + " 个字符");
        throwIf(command.imageFile() != null && !command.imageFile().isEmpty()
                        || command.imageUrl() != null && !command.imageUrl().isEmpty(),
                "待发送队列只支持文本，请在会话空闲时发送图片");
        throwIf(total >= PROCESS_LIMIT, "待发送队列已满，请稍后再试");
        SessionQueue queue = queues.computeIfAbsent(sessionId, ignored -> new SessionQueue());
        throwIf(queue.entries.size() >= SESSION_LIMIT, "当前会话最多可以排队 " + SESSION_LIMIT + " 条消息");

        ChatCommand textCommand = ChatCommand.builder()
                .modelId(command.modelId())
                .sessionId(sessionId)
                .workspaceId(command.workspaceId())
                .input(command.input())
                .messageId(null)
                .agentId(command.agentId())
                .requirePlan(command.requirePlan())
                .imageFile(List.of())
                .imageUrl(List.of())
                .build();

        Ticket ticket = new Ticket(UUID.randomUUID().toString(), ++sequence, textCommand);
        queue.entries.add(ticket);
        total++;
        return ticket.id();
    }

    public synchronized boolean hasPending(long sessionId) {
        return queues.containsKey(sessionId);
    }

    public synchronized List<Long> dispatchableSessions() {
        return queues.entrySet().stream().filter(entry -> entry.getValue().canDispatch())
                .map(Map.Entry::getKey).toList();
    }

    public synchronized Ticket claim(long sessionId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null || !queue.canDispatch()) return null;
        queue.claimed = queue.entries.element();
        return queue.claimed;
    }

    public synchronized void admitted(long sessionId, Ticket ticket) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null || queue.claimed != ticket) return;
        queue.claimed = null;
        remove(sessionId, queue, ticket);
    }

    public synchronized void failed(long sessionId, Ticket ticket, String message) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null || queue.claimed != ticket) return;
        queue.claimed = null;
        queue.paused = true;
        queue.failure = message;
    }

    public synchronized void pause(long sessionId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue != null) queue.paused = true;
    }

    public synchronized void resume(long sessionId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null) return;
        queue.failure = null;
        queue.paused = false;
    }

    public synchronized boolean deferAutomatic(long sessionId, long executionId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null) return false;
        queue.deferredExecutionId = queue.deferredExecutionId == null ? executionId
                : Math.max(queue.deferredExecutionId, executionId);
        return true;
    }

    public synchronized Long cancel(long sessionId, String pendingId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null) return null;
        throwIf(queue.claimed != null && queue.claimed.id().equals(pendingId), "这条消息正在发送");
        Ticket ticket = queue.entries.stream().filter(item -> item.id().equals(pendingId)).findFirst().orElse(null);
        if (ticket == null) return null;
        if (ticket == queue.entries.peek()) queue.failure = null;
        remove(sessionId, queue, ticket);
        return queue.entries.isEmpty() ? queue.deferredExecutionId : null;
    }

    public synchronized void discard(long sessionId) {
        SessionQueue queue = queues.remove(sessionId);
        if (queue != null) total -= queue.entries.size();
    }

    public synchronized Snapshot snapshot(long sessionId) {
        SessionQueue queue = queues.get(sessionId);
        if (queue == null) return new Snapshot(false, null, List.of());
        List<Entry> entries = queue.entries.stream().sorted(ORDER)
                .map(ticket -> new Entry(ticket.id(), ticket.command().input(), queue.claimed == ticket))
                .toList();
        return new Snapshot(queue.paused, queue.failure, entries);
    }

    private void remove(long sessionId, SessionQueue queue, Ticket ticket) {
        queue.entries.remove(ticket);
        total--;
        if (queue.entries.isEmpty()) queues.remove(sessionId);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }


}
