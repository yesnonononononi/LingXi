package com.summit.dp.shared.context;

import java.util.function.Supplier;

/**
 * 子代理会话的执行上下文：记录委派链上的根会话与子 Agent 身份。
 *
 * <p>框架侧只知道 sessionId，无法表达"这条会话是某个会话派生的"，因此由委派发生在的工具层绑定，
 * 会话首次落库时再回填 {@code session.root_session_id} 与 {@code session.agent_id}。
 * 委派关系以会话行上的 {@code root_session_id} 为唯一事实源，消息行不再冗余该信息。
 */

public final class SessionContextEntity {

    private static final InheritableThreadLocal<SubSession> CURRENT = new InheritableThreadLocal<>();

    private SessionContextEntity() {
    }

    /** 当前会话所属的根会话 ID；不在委派链上时返回 {@code null} */

    public static Long currentRootSessionId() {
        SubSession current = CURRENT.get();
        return current == null ? null : current.rootSessionId();
    }

    /** 当前会话绑定的 Agent ID；不在委派链上时返回 {@code null} */
    public static Long currentAgentId() {
        SubSession current = CURRENT.get();
        return current == null ? null : current.agentId();
    }

    /**
     * 给定会话的根会话 ID：仅当它确实是子会话（存在委派上下文且不等於自身）时才回指。
     *
     * @param sessionId 待判断的会话 ID
     */
    public static Long rootSessionIdOf(Long sessionId) {
        Long root = currentRootSessionId();
        if (root == null || sessionId == null || root.equals(sessionId)) return null;
        return root;
    }

    /** 在子代理上下文中执行 {@code action}，结束后恢复调用前的绑定 */
    public static <T> T runWithSubSession(Long rootSessionId, Long agentId, Supplier<T> action) {
        SubSession previous = CURRENT.get();
        CURRENT.set(new SubSession(rootSessionId, agentId));
        try {
            return action.get();
        } finally {
            restore(previous);
        }
    }

    private static void restore(SubSession previous) {
        if (previous == null) CURRENT.remove();
        else CURRENT.set(previous);
    }

    private record SubSession(Long rootSessionId, Long agentId) {
    }
}
