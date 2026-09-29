package com.summit.dp.execution.application.service;

import com.summit.core.agent.ExecutionState;

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
}
