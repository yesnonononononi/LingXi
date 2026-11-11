package com.summit.dp.session.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.Session;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** session 表仓储，只负责会话元数据。 */
public interface SessionRepository extends RepositoryTemplate<Session, Long> {
    Long saveAndReturnId(Session session);

    Optional<Session> lockById(Long sessionId);

    /** 已读状态由单语句条件更新裁决，避免旧读取覆盖新状态。 */
    boolean markReadIfUnread(Long sessionId, Long expectedVersion);

    void updateRead(Session session);

    List<Session> findRootSessions();

    /** 应用状态快照必须包含子会话，供重连补齐未读状态。 */
    List<Session> findApplicationSessions();

    /** 根会话分页：过滤掉子代理会话，避免同一次委派在列表里重复出现。 */
    IPage<Session> queryRootPage(int current, int size);

    /** 会话树：根会话自身 + 其下全部子会话，平铺返回（按主键升序）。 */
    List<Session> findSessionTree(Long rootSessionId);

    /**
     * 按「根会话 + Agent」取已存在的子代理会话。
     *
     * <p>这是「主理人委派时优先复用而非无脑派生」的反查入口：同一根会话下同一 Agent 只应有一个
     * 子会话，命中则复用其上下文继续对话。取最新一条（id 倒序）：历史数据若因旧逻辑产生过重复
     * 子会话，复用的应是用户最近在用的那个。</p>
     *
     * @param rootSessionId 根会话 id
     * @param agentId       子 Agent id
     * @return 命中的子会话；不存在时为 {@link Optional#empty()}
     */
    Optional<Session> findByRootAndAgent(Long rootSessionId, Long agentId);

    /** 按主键删掉这批会话行。 */
    int deleteByIds(Collection<Long> ids);

    /**
     * 解析出 {@code id} 所属整棵会话树的会话 id（**只读，不删**）。
     *
     * <p>删除前必须先知道要删哪些会话：执行闸门、级联清理都按这批 id 走。
     * 根解析只有这一处，避免「查的是这棵树、删的是另一棵」。</p>
     *
     * @param id 根会话或子会话 id
     * @return 整棵树的会话 id（含根），按主键升序
     */
    List<Long> resolveTreeIds(Long id);

    /**
     * 从候选里挑出**仍然存在**的会话 id（一次 {@code IN} 查询）。
     *
     * <p>孤儿清扫拿它做存在性判定：逐个会话查一次会在历史几百个目录上变成 N 次往返。</p>
     *
     * @param ids 候选会话 id；空入参返回空列表
     * @return 库内仍存在的那些 id（顺序不保证）
     */
    List<Long> findExistingIds(Collection<Long> ids);
}
