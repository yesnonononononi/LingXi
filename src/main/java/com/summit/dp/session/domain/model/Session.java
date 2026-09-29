package com.summit.dp.session.domain.model;


import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NonNull;

import java.time.Instant;
import java.util.List;

/**
 * 会话聚合根。框架对象只在应用层转换，不进入领域与持久化层。
 *
 * <p>本聚合不持有任何执行状态：过程状态（进行中/待恢复/完成/失败/取消）的唯一归属是
 * execution 表，由框架执行循环独占写入；会话展示所需的运行态由查询时组合得出
 * （见 SessionVO 的 runStatus / lastOutcome）。</p>
 */
@Getter
@Builder(toBuilder = true)
@AllArgsConstructor
public class Session {

    /**
     * 根会话自身的 {@code rootSessionId} 取值：会话不由任何会话派生。
     */
    public static final long ROOT_SESSION_ID = 0L;
    public static final int MAX_SESSION_NAME_LENGTH = 25;

    private final Long id;

    /** 所属根会话 id；{@code 0}（{@link #ROOT_SESSION_ID}）表示自身即根会话。 */
    private final Long rootSessionId;

    private String name;

    private Long workspaceId;

    /** 绑定的协作团队，仅创建时写入；{@code null}=非团队会话（后续轮次请求值一律忽略）。 */
    private Long teamId;

    private TokenUsage tokenUsage ;
    private final Instant createTime;
    private Instant updateTime ;

    /** 消息视图（仅内存装配，不落库）；{@code @Builder.Default} 避免 null。 */
    @Builder.Default
    private List<SessionMessage> messages = List.of();

    public boolean isSubSession() {
        return rootSessionId != null && rootSessionId != ROOT_SESSION_ID;
    }

    public void rename(@NonNull String name) {
        if (name.isEmpty()) return;
        this.name = name.substring(0, Math.min(MAX_SESSION_NAME_LENGTH, name.length()));
        update();
    }

    public void addTokenUsage(TokenUsage tokenUsage) {
        this.tokenUsage = this.tokenUsage.add(tokenUsage);
        update();
    }

    private void update() {
        this.updateTime = Instant.now();
    }

}
