package com.summit.dp.shared.event;

import java.util.Set;

/**
 * 已提交事实的通知。
 *
 * <p><b>两个会话字段各司其职，不可混用</b>：{@code rootSessionId} 是**投递目标**（v3 连接按根会话
 * 归档，前端只订阅根连接）；{@code sessionId} 是**实体归属**（这条事实属于哪个会话，子会话即子会话）。
 * 子会话事实必须由生产者在写库那一刻带上根身份 —— 观察者拿不到执行元数据，回查就等于每次提交都反查一次。</p>
 */
public record CommittedStateChange(Kind kind, Long rootSessionId, Long sessionId, String id,
                                   Long historyRevision, Set<String> turnIds, Set<String> executionIds,
                                   Object payload) {
    public enum Kind { TOOL, TURN, SESSION, EXECUTION, MESSAGE, HISTORY }
    public CommittedStateChange {
        turnIds = turnIds == null ? Set.of() : Set.copyOf(turnIds);
        executionIds = executionIds == null ? Set.of() : Set.copyOf(executionIds);
    }

    /**
     * 无根身份、无事实的身份通知。
     *
     * <p>只适用于**不需要投递到具体连接**的种类（如启动收尸的 TURN/EXECUTION 摘要）：观察者
     * 对缺根身份的 MESSAGE/TURN 会告警并跳过，**不会**回落自身会话 —— 回落正是「子会话提交
     * 静默投错桶」那条故障本身。</p>
     */
    public static CommittedStateChange entity(Kind kind, Long sessionId, Object id) {
        return new CommittedStateChange(kind, null, sessionId, String.valueOf(id), null, Set.of(), Set.of(), null);
    }

    /**
     * 带已提交事实的身份通知（根身份未知）。
     *
     * <p><b>为什么要在通知里带上事实</b>：v3 直投要求「发送时不重新查库」。观察者若只拿到 id，
     * 就必须回查一次实体才能构造帧 — 那是每次提交都发生的反查。生产者在写库那一刻手里已有实体，
     * 把它作为<b>不可变快照</b>随通知下发，观察者就只需转换、不再触达仓储。</p>
     *
     * <p>{@code payload} 必须是提交那一刻的终值快照，禁止传随后仍会被修改的领域对象引用；
     * 为 {@code null} 时表示该通知不携带事实，观察者按旧语义回查。</p>
     */
    public static CommittedStateChange of(Kind kind, Long sessionId, Object id, Object payload) {
        return new CommittedStateChange(kind, null, sessionId, String.valueOf(id), null, Set.of(), Set.of(), payload);
    }

    /**
     * 带**根身份**与已提交事实的通知 —— 子会话事实必须走这个入口。
     *
     * @param rootSessionId 投递目标（根会话连接）
     * @param sessionId     实体归属（子会话即子会话自身）
     */
    public static CommittedStateChange of(Kind kind, Long rootSessionId, Long sessionId,
                                          Object id, Object payload) {
        return new CommittedStateChange(kind, rootSessionId, sessionId, String.valueOf(id),
                null, Set.of(), Set.of(), payload);
    }
}
