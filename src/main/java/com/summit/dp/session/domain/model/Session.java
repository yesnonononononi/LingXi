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

    /**
     * 会话归属的 Agent；{@code null}=未绑定 Agent。
     *
     * <p>根会话与普通会话不持有个体 Agent（身份由单例设置承载），恒为 {@code null}；
     * 子代理会话在委派落库时写入其子 Agent，构成
     * 「同一根会话下同一 Agent 复用同一子会话」的反查键
     * （见 {@code SessionRepository#findByRootAndAgent}）。</p>
     */
    private Long agentId;

    private String name;

    private Long workspaceId;

    /**
     * 绑定的协作团队；{@code null}=非团队会话。
     *
     * <p>可变：由前端团队选择同步（见 {@link #changeTeam}）。与 workspaceId 不同 ——
     * 工作空间的绑定是创建时一次性确定的（后置改写会把会话引到另一个宿主机目录），
     * 而团队只影响编排身份，不含宿主机路径，因此允许会话中途换绑。</p>
     */
    private Long teamId;
    private final Instant createTime;
    private Instant updateTime ;

    /**
     * 上下文用量快照：最近一次终结执行上报的模型上下文占用。
     *
     * <p>由框架 loop 结束填充的 {@code Execution.contextUsageMetric} 经生命周期端口同步落库
     * （{@code SessionContextMetricListener}），随 {@code /session/tree} 接口下发供前端
     * 「上下文用量」指示器在**无任何 loop 运行**（历史加载、刷新页面）时也能展示——
     * 实时口径仍以 {@code CONTEXT_UPDATE} 事件为准，本快照只兜住「没有事件可发」的空窗。</p>
     */
    private Long contextTokenCount;
    /** 上报时的上下文上限 token（框架运行时 max-tokens）；null=尚未采集。 */
    private Integer contextMaxTokens;
    /** {@code contextTokenCount / contextMaxTokens}，可能大于 1（超限）；null=尚未采集。 */
    private Double contextRatio;

    /** 消息视图（仅内存装配，不落库）；{@code @Builder.Default} 避免 null。 */
    @Builder.Default
    private List<SessionMessage> messages = List.of();

    public boolean isSubSession() {
        return rootSessionId != null && rootSessionId != ROOT_SESSION_ID;
    }

    /**
     * 回写上下文用量快照。与 {@link #changeTeam} 不同构：这是统计型旁路数据，
     * **不刷新 {@code updateTime}**——会话列表按更新时间排序，用量回写不该把会话顶到最前。
     * {@code tokenCount} 为 null（执行异常未采集到）时整体跳过，保留上一次已知值。
     */
    public void changeContextUsage(Long tokenCount, Integer maxTokens, Double ratio) {
        if (tokenCount == null || tokenCount < 0) return;
        this.contextTokenCount = tokenCount;
        this.contextMaxTokens = maxTokens;
        this.contextRatio = ratio;
    }

    public void rename(@NonNull String name) {
        if (name.isEmpty()) return;
        this.name = name.substring(0, Math.min(MAX_SESSION_NAME_LENGTH, name.length()));
        update();
    }

    /**
     * 换绑协作团队。{@code null} 表示解绑（回到非团队会话，按单 Agent / 裸模型编排）。
     *
     * <p>与 rename 同构：变更非 final 字段后统一刷新 {@code updateTime}。
     * 是否允许在运行中换绑由应用层判定，领域模型不感知执行状态。</p>
     */
    public void changeTeam(Long teamId) {
        this.teamId = teamId;
        update();
    }

    /**
     * 绑定会话归属的 Agent（子代理会话落库时写入）。
     *
     * <p>与 {@link #changeTeam} 同构：变更非 final 字段后刷新 {@code updateTime}。
     * 不在此处限制「只能子会话绑定」——那是应用层编排事实，领域模型不感知会话派生关系。</p>
     */
    public void changeAgent(Long agentId) {
        this.agentId = agentId;
        update();
    }

    private void update() {
        this.updateTime = Instant.now();
    }

}
