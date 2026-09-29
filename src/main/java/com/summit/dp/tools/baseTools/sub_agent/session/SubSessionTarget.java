package com.summit.dp.tools.baseTools.sub_agent.session;

import com.summit.core.conversation.message.Message;

import java.util.List;

/**
 * 本次委派应落到哪个子会话。
 *
 * @param subSessionId  目标子会话 id
 * @param reused        {@code true} 表示命中已有子会话并携带其历史上下文；{@code false} 表示需新建会话行
 * @param priorMessages 复用时的既有模型上下文；首次委派为空列表
 */
public record SubSessionTarget(String subSessionId, boolean reused, List<Message> priorMessages) {

    /** 首次委派：会话行尚未落库，由调用方在通过取消校验后创建。 */
    public static SubSessionTarget fresh(String subSessionId) {
        return new SubSessionTarget(subSessionId, false, List.of());
    }

    /** 命中复用：历史上下文可能为空（上下文丢失时降级为「接着聊但看不到之前」），复用本身不因此失败。 */
    public static SubSessionTarget reused(String subSessionId, List<Message> priorMessages) {
        return new SubSessionTarget(subSessionId, true, priorMessages == null ? List.of() : List.copyOf(priorMessages));
    }

    public Long numericSubSessionId() {
        return Long.valueOf(subSessionId);
    }
}
