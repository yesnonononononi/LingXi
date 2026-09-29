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
     * <p>{@code teamId} 是团队绑定的唯一写入时机（与 workspaceId 同构）：仅创建那一刻生效，
     * 为 null 表示非团队会话；此后不可变，后续轮次请求值一律忽略。</p>
     */
    Result<Long> initialize(String input, Long workspaceId, Long teamId);

    Result<Void> update(SessionCommand command);

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
