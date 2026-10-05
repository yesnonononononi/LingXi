package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import com.summit.dp.turn.application.vo.ChatTurnVO;
import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 重连显式同步信封（§8.2）：前端收到 v3 的 {@code STREAM_READY} 后发一次本查询，
 * 用它拿持久化状态与实时帧做合并。
 *
 * <p><b>本类只装信封，不新造读路径</b>：字段全部复用现有查询端口的既有 VO ——
 * 会话树用 {@link SessionTreeVO}/{@link SessionVO}，历史页用 {@link SessionMessagePageVO}，
 * 未决卡片用 {@link ToolCallVO}，进行中轮次用 {@link ChatTurnVO}，执行状态用
 * {@link ExecutionStateVO}。查询次数由实体种类决定，不随片段/工具/子会话数量产生 N+1。</p>
 *
 * <p><b>字段语义</b>：</p>
 * <ul>
 *   <li>{@code rootSessionId}：请求路径参数的回显；根由 {@code sessions} 里 {@code id ==
 *       rootSessionId} 那条判定。</li>
 *   <li>{@code historyRevision}：根会话当前代际；读取前后各取一次，变了则有限重读。
 *       前端据它判「本代际是否整体作废」（§8.1 退出路径 3）。</li>
 *   <li>{@code sessions}：会话树平铺（根 + 全部子会话），每项自带 version/historyRevision/runStatus。</li>
 *   <li>{@code history}：当前历史页（首屏）。{@code turns} 是「已终结轮次摘要」，与
 *       {@link #turns}（进行中轮次）互补不重叠。</li>
 *   <li>{@code toolCalls}：全部未决卡片，不受历史分页窗口限制。</li>
 *   <li>{@code turns}：进行中（ACCEPTED/RUNNING/WAITING）轮次；已终结的走 {@code history.turns}。</li>
 *   <li>{@code executions}：本根会话下「进行中或挂起」的执行，供前端判 §8.1 退出路径 2。</li>
 * </ul>
 *
 * <p><b>明确排除</b>：不分页历史全量、不加载 snapshot、不下发 {@code ExecutionSummary} 的统计、
 * 不下发已终结卡片（{@code history.records[].toolCall} 已覆盖）。</p>
 */
@Data
@Builder
public class SessionBootstrapVO {

    /** 请求路径参数的根会话 id 回显（雪花 ID，字符串下发）。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long rootSessionId;

    /** 根会话当前历史代际；前/后各读一次，变了则有限重读后返回稳定值。 */
    private Long historyRevision;

    /** 会话树平铺（根 + 全部子会话）。 */
    private List<SessionVO> sessions;

    /** 当前历史页（首屏），含 records/turns/nextCursor/hasMore。 */
    private SessionMessagePageVO history;

    /** 全部未决卡片（不受历史分页窗口限制）。 */
    private List<ToolCallVO> toolCalls;

    /** 进行中（ACCEPTED/RUNNING/WAITING）轮次。 */
    private List<ChatTurnVO> turns;

    /** 本根会话下「进行中或挂起」的执行。 */
    private List<ExecutionStateVO> executions;
}
