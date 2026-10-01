package com.summit.dp.shared.vo;


import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/** 列表、详情与会话树共用的会话视图。 */
@Data
@Builder
public class SessionVO {
    @JsonSerialize(using = ToStringSerializer.class)
    private Long id;
    private String name;
    /**
     * 展示状态组合（后端唯一来源，前端不再猜测）：进行中状态，取值 IDLE | RUNNING | SUSPENDED。
     * 无进行中执行时为 IDLE（缺省输出 IDLE，前端免判空）。
     */
    private String runStatus;
    /**
     * 展示状态组合：最近一次已终结执行的结果，取值 COMPLETED | FAILED | CANCELLED；从未终结为 null。
     * 与 {@link #runStatus} 相互独立、可同时非空。
     */
    private String lastOutcome;
    /**
     * 会话绑定的 Agent；{@code null} 表示未绑定 Agent 的普通会话 / 根会话。
     * <p>子代理会话返回其自身的子 Agent（{@code session.agent_id}），不再回落全局单例身份。</p>
     */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long agentId;
    /** 会话绑定的 Agent 名称（冗余字段供视图展示） */
    private String agentName;
    /** 所属根会话 ID；0 表示自身就是根会话（团队模式下的委派发起会话） */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long rootSessionId;
    /** 会话创建时间；子会话用它与父消息流按时间归并 */
    private Instant createTime;
    /** 会话最近更新时间。 */
    private Instant updateTime;
    /** 绑定的工作空间 id（可空） */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long workspaceId;
    /** 绑定的协作团队 id（可经 /session/{id}/team 换绑；null=非团队会话） */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long teamId;
    private String workDir;
    /** 树查询批量统计的消息条数；未查询时不输出该字段。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Long messageCount;

    /**
     * 上下文用量快照（三项同源，来自最近一次终结执行回写的 session 表快照）：
     * 已用 token / 上限 token / 比率（可能大于 1）。任一项为 null 表示尚未采集——
     * 前端「上下文用量」指示器在无 {@code CONTEXT_UPDATE} 事件（历史加载）时以此渲染。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Long contextTokenCount;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer contextMaxTokens;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double contextRatio;
}
