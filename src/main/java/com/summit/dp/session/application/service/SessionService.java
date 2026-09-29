package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionTreeVO;
import com.summit.dp.shared.vo.SessionVO;

public interface SessionService {
    /**
     * 仅供聊天编排初始化会话，名称由首条用户输入截断生成。
     *
     * <p>{@code agentId} 已不再随会话落库：Agent 身份由单例设置（{@code user_configs.agent_id}）承载，
     * 对外经 {@code SettingsProvider} 下发。</p>
     *
     * <p>{@code teamId} 为 null 表示非团队会话；创建时带值即为首轮绑定，
     * 此后仍可通过 {@link #bindTeam} 换绑。</p>
     */
    Result<Long> initialize(String input, Long workspaceId, Long teamId);

    /**
     * 更新会话元数据（名称）。{@code teamId} 的换绑请走 {@link #bindTeam}：
     * 本方法无法表达「解绑到 null」，用 {@code null} 语义会与「不改」混淆。
     */
    Result<Void> update(SessionCommand command);

    /**
     * 换绑会话的协作团队；{@code teamId} 为 null 表示解绑（回到非团队会话）。
     *
     * <p>执行中（RUNNING）拒绝换绑：本轮的编排身份已在执行快照里固化，中途换绑会让
     * 「本轮按 A 队跑、恢复后按 B 队跑」，语义不成立。</p>
     */
    Result<Void> bindTeam(Long sessionId, Long teamId);

    Result<Void> del(Long id);

    Result<PageResult<SessionVO>> list(Integer page, Integer pageSize);

    /**
     * 按主键取会话；不存在时抛「会话不存在」（全局处理器转 403）。
     *
     * <p>本地单实例（HC-1）没有归属维度：会话的可见性由「知道 id」承载，
     * 与消息、工作空间一致。</p>
     */
    Result<SessionVO> findById(Long id);

    /**
     * 按雪花主键游标分页拉取会话消息：首屏返回最新的一页，向上翻页返回更早的一页。
     *
     * @param cursor 上一页最老一条消息的 id，为空表示从最新一条开始
     */
    Result<SessionMessagePageVO> messages(Long sessionId, String cursor, Integer size);

    /**
     * 会话树：一次返回根会话 + 其下全部子会话（平铺列表，前端用 {@code id == rootSessionId} 判根），
     * 子会话详情再按 id 请求 {@code /session/{id}/messages}。
     *
     * @param sessionId 根会话 id 或任意子会话 id
     */
    Result<SessionTreeVO> tree(Long sessionId);

    /** 绑定/解绑会话的工作空间。 */
    Result<Void> bindWorkspace(Long sessionId, Long workspaceId);
}
