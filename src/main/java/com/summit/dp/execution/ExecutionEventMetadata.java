package com.summit.dp.execution;

import java.util.HashMap;
import java.util.Map;

/** Explicit business identifiers allowed to travel with framework events. */
public final class ExecutionEventMetadata {
    public static final String ROOT_SESSION_ID = "rootSessionId";
    public static final String SESSION_ID = "sessionId";
    public static final String TURN_ID = "turnId";
    public static final String PARENT_TURN_ID = "parentTurnId";
    public static final String HISTORY_REVISION = "historyRevision";
    public static final String AGENT_ID = "agentId";
    public static final String AGENT_NAME = "agentName";

    private ExecutionEventMetadata() {
    }

    /**
     * 构造一次执行的完整归属元数据。
     *
     * <p>ID 与版本统一写成十进制字符串：雪花 ID 超出 JS 安全整数范围，数值节点会被前端精度截断。</p>
     *
     * <p><b>为什么是「同源、值一致的快照」而不是同一个对象</b>：框架
     * {@code AgentRuntimeParameters} 的 get/set 都做 {@code Map.copyOf}，set 换的是新引用，
     * 因此<b>已构造出的下游对象看不到后续写回</b>。这正是「下一轮改 key 不改变已创建事件归属」
     * 的依据 —— 本方法返回的是一份不可变快照，调用方后续再写元数据不会影响此前的读者。</p>
     *
     * @param rootSessionId   根会话 ID；根任务等于 sessionId，子任务指向委派发起方
     * @param sessionId       本次执行所属会话 ID（子执行取其子会话）
     * @param turnId          业务轮次 ID；受理落库后才已知，未知时传 {@code null}
     * @param parentTurnId    发起本次子委派的主轮次 ID；普通用户提问为 {@code null}
     * @param historyRevision 构建时根会话的历史代际快照
     */
    public static Map<String, Object> of(long rootSessionId, long sessionId, Long turnId,
                                          Long parentTurnId, long historyRevision) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put(ROOT_SESSION_ID, Long.toString(rootSessionId));
        metadata.put(SESSION_ID, Long.toString(sessionId));
        if (turnId != null) {
            metadata.put(TURN_ID, turnId.toString());
        }
        if (parentTurnId != null) {
            metadata.put(PARENT_TURN_ID, parentTurnId.toString());
        }
        metadata.put(HISTORY_REVISION, Long.toString(historyRevision));
        return Map.copyOf(metadata);
    }

    /**
     * 子执行的归属元数据：在通用归属之上追加被委派的 Agent 身份。
     *
     * <p>子会话行虽然落了库，但前端在收到会话树之前只能靠事件认出「这条子执行是谁」：
     * 不带 agentId/agentName 时，左侧成员名只能退化成「子代理 #N」这种凭空编的序号。</p>
     *
     * @param agentId   Agent ID；写成十进制字符串，避免雪花 ID 被 JS 精度截断
     * @param agentName Agent 名称；为空时不占该键
     */
    public static Map<String, Object> ofSubAgent(long rootSessionId, long sessionId, Long turnId,
                                                 Long parentTurnId, long historyRevision,
                                                 Long agentId, String agentName) {
        Map<String, Object> metadata =
                new HashMap<>(of(rootSessionId, sessionId, turnId, parentTurnId, historyRevision));
        if (agentId != null) {
            metadata.put(AGENT_ID, Long.toString(agentId));
        }
        if (agentName != null && !agentName.isBlank()) {
            metadata.put(AGENT_NAME, agentName);
        }
        return Map.copyOf(metadata);
    }

    /** 业务轮次 ID；缺失或不可解析返回 {@code null}。 */
    public static Long turnId(Map<String, Object> metadata) {
        return ExecutionAttributes.readLong(metadata, TURN_ID);
    }

    /** 执行所属会话 ID；缺失或不可解析返回 {@code null}（旧检查点可能没有该键）。 */
    public static Long sessionId(Map<String, Object> metadata) {
        return ExecutionAttributes.readLong(metadata, SESSION_ID);
    }

    /** 根会话 ID；缺失或不可解析返回 {@code null}（旧检查点可能没有该键）。 */
    public static Long parseRootSessionId(Map<String, Object> metadata) {
        return ExecutionAttributes.readLong(metadata, ROOT_SESSION_ID);
    }

    /** 历史代际；缺失或不可解析返回 {@code null}（旧检查点可能没有该键）。 */
    public static Long parseHistoryRevision(Map<String, Object> metadata) {
        return ExecutionAttributes.readLong(metadata, HISTORY_REVISION);
    }
}
