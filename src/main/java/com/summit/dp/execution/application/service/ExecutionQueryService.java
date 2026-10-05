package com.summit.dp.execution.application.service;

import com.summit.core.agent.ExecutionState;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * 跨模块读应用的执行查询服务（读侧唯一入口）。
 *
 * <p>session 模块经此服务读取执行过程状态用于展示组合，**不得**直接接触
 * {@code ExecutionMapper} / {@code ExecutionPO}。返回框架已有的执行状态枚举。</p>
 */
public interface ExecutionQueryService {

    /**
     * 批量取每个会话各状态最新一次对应的执行状态，按执行 id 降序排列。
     *
     * <p>入参为空（null 或空集合）返回空 Map；某会话无任何执行行时不会出现在 Map 中，
     * 每种状态仅保留一次，调用方分别取首个进行态与首个终态组合展示。</p>
     *
     * @param sessionIds 会话 id 集合
     * @return sessionId -> 执行状态列表（仅含有执行事实的会话）
     */
    Map<Long, List<ExecutionState>> latestStatesBySession(Collection<Long> sessionIds);

    /**
     * 按执行 id 批量取查询摘要（状态 / 开始结束时间）。
     *
     * <p><b>一次 IN 查询</b>，不做逐条查询：一页最多涉及几十个执行，逐个查就是 N+1。
     * 不加载 snapshot。空入参返回空 Map；不存在的执行 id 直接缺席（调用方按「摘要缺失」降级）。</p>
     *
     * @param executionIds 执行 id 集合
     * @return executionId -> 摘要
     */
    Map<Long, ExecutionSummary> summariesByIds(Collection<Long> executionIds);

    String findSnapshotById(Long executionId);

    /**
     * 批量取「进行中或挂起」的执行（带执行身份），用于 v3 bootstrap（§8.2）。
     *
     * <p><b>为什么要这个方法而不是复用 {@link #latestStatesBySession}</b>：后者只回
     * {@link ExecutionState}，<b>不带执行 ID</b>，而 bootstrap 的 {@code executions[].executionId}
     * 是前端判 §8.1「退出路径 2（所属执行终结 / 挂起）」的依据 —— 只有状态没有身份，
     * 前端无法把「哪个执行结束了」对应到接续片段。本方法一次 {@code IN} 查询返回
     * 身份 + 状态 + 起止时间，不做 N+1。</p>
     *
     * <p>只回 CREATED / RUNNING / SUSPENDED（对应库状态 0/1/2）—— 终态执行不参与
     * 「是否仍在进行」的判定，不下发（§8.2「不下的东西」：不分页历史、不加载 snapshot）。</p>
     *
     * @param sessionIds 会话 id 集合
     * @return 未终结执行列表；空入参返回空列表
     */
    List<ActiveExecution> activeBySession(Collection<Long> sessionIds);

    /**
     * 「进行中或挂起」执行的身份化视图（读侧）。
     *
     * <p>{@code status} 是框架 {@link ExecutionState} 枚举名，与实时
     * {@code EXECUTION_UPDATED.data.state} 同字面量集合；{@code startedAt}/{@code completedAt}
     * 未采到为 {@code null}（未终结执行通常 {@code completedAt} 为空）。</p>
     */
    record ActiveExecution(
            Long executionId,
            Long sessionId,
            String status,
            Instant startedAt,
            Instant completedAt
    ) {
    }

    /**
     * 一次执行的查询摘要（读侧视图）。
     *
     * <p><b>消费者是会话 bootstrap</b>（{@code SessionBootstrapService}）：它用一次 IN 查询
     * 把未决工具调用卡片所指向执行的**状态与起止时间**补进装配，比反序列化整段 snapshot 便宜得多。
     * **不对外下发**（原先对应的 {@code ExecutionSummaryVO} 已随轮次链路替换而删除）。</p>
     *
     * <p><b>为什么没有模型与 token</b>：它们是业务事实，权威在 {@code chat_turn} ——
     * 模型由业务受理时解析写入，用量由框架三个终态事件（完成 / 失败 / 取消，均带
     * {@code tokenInfo}）覆盖回填。本摘要只回答「这个执行结束了吗、什么时候结束的」。</p>
     *
     * <p>{@code sessionId} 用于**校验装配归属**：调用方只允许把摘要挂到本会话的执行上，
     * 否则一个串错的 id 就能让 A 会话读到 B 会话的状态。</p>
     */
    record ExecutionSummary(
            Long executionId,
            Long sessionId,
            String status,
            Instant startedAt,
            Instant completedAt
    ) {
    }
}
