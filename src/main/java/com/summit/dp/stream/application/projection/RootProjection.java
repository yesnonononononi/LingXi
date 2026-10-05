package com.summit.dp.stream.application.projection;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.stream.application.protocol.StreamSnapshot;
import java.time.Instant;
import java.util.*;

/** 门闩内只保存客户端数据，不读数据库、不写网络。 */
public class RootProjection {
    public final String rootSessionId;
    public final String epoch = String.valueOf(IdUtil.getSnowflakeNextId());
    public long seq;
    public long historyRevision = 1;
    public Instant lastTouched = Instant.now();
    public final Map<String, ObjectNode> sessions = new LinkedHashMap<>();
    public final Map<String, ObjectNode> turns = new LinkedHashMap<>();
    public final Map<String, ObjectNode> executions = new LinkedHashMap<>();
    public final Map<String, ObjectNode> messages = new LinkedHashMap<>();
    public final Map<String, ObjectNode> tools = new LinkedHashMap<>();
    public final Set<String> invalidTurns = new HashSet<>();
    public final Set<String> invalidExecutions = new HashSet<>();
    /**
     * 最近窗口内已应用的事件标识，去重用。
     *
     * <p>用 {@link LinkedHashSet} 而非 {@code Map<String, Boolean>}：值恒为 {@code true}，
     * 从不读取，Map 形式只是把「集合」误写成「字典」，读代码的人会以为存在
     * 「同一 eventId 标记为 false」这类语义。用 Set 后 {@code contains}/{@code add}/{@code remove}
     * 的意图自明，淘汰最旧项也只需取迭代器首个。</p>
     */
    public final Set<String> appliedIds = new LinkedHashSet<>();
    public RootProjection(long rootId) { rootSessionId = String.valueOf(rootId); }

    public StreamSnapshot snapshot() {
        List<String> retained = new ArrayList<>(turns.keySet());
        return new StreamSnapshot(epoch, String.valueOf(seq), String.valueOf(historyRevision),
                new StreamSnapshot.Scope(new ArrayList<>(sessions.keySet()), retained, retained, true, false),
                copy(sessions), copy(turns), copy(executions), copy(messages), copy(tools));
    }
    private static List<ObjectNode> copy(Map<String, ObjectNode> values) {
        return values.values().stream().map(ObjectNode::deepCopy).toList();
    }
    /**
     * 缺 status 时按终态处理。
     *
     * <p>投影里的执行事件可能先于执行行落库到达，此时 payload 没有 status 字段。
     * 若按「非终态」判，这个根会话会被永久钉在「有未完成工作」里，空闲回收（TTL）永远不触发 ——
     * 所以缺失一律当终态，宁可早回收也不能泄漏。</p>
     */
    private static final int MISSING_STATUS_ASSUMED_TERMINAL = ExecutionStatusCodes.TERMINAL_THRESHOLD;

    public boolean hasUnfinishedWork() {
        return executions.values().stream()
                .anyMatch(value -> value.path("status").asInt(MISSING_STATUS_ASSUMED_TERMINAL)
                        < MISSING_STATUS_ASSUMED_TERMINAL)
                || tools.values().stream().anyMatch(value -> value.path("pending").asBoolean());
    }
}
