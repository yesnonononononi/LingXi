package com.summit.dp.turn.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.turn.domain.model.ChatTurn;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** chat_turn 表仓储。 */
public interface ChatTurnRepository extends RepositoryTemplate<ChatTurn, Long> {

    /**
     * 落库并随通知带上根身份。
     *
     * @param rootSessionId v3 投递目标（根会话）；子会话轮次必须传根，否则投错连接桶
     */
    void save(ChatTurn turn, Long rootSessionId);

    /** 更新并发布落库终值；根身份语义同 {@link #save(ChatTurn, Long)}。 */
    void updateById(ChatTurn turn, Long rootSessionId);

    /**
     * 按框架执行 ID 反查轮次。
     *
     * <p>{@code execution_id} 上有唯一键，因此这是一次唯一键查询 —— 也是「框架给的 executionId
     * 反查业务轮次」的唯一入口。框架的观察钩子只给 executionId，业务靠它把信号落到自己的轮次上。</p>
     */
    Optional<ChatTurn> findByExecutionId(Long executionId);

    /**
     * 按命令受理身份反查轮次。
     *
     * <p>同 {@code commandId} 的重试靠它查回首次受理结果：命中即说明这条命令已经被受理过，
     * 不再写用户消息、不再开启执行。查不到说明是首次受理。</p>
     */
    Optional<ChatTurn> findByCommandId(String commandId);

    /**
     * 按一批执行 ID 批量反查轮次（一次 IN 查询，不做 N+1）。
     *
     * <p>历史接口用它把本页消息的 {@code executionId} 映射到 {@code turnId}：
     * 消息行在本次改造里仍只存 {@code execution_id}，轮次身份靠这一次批量映射补上。</p>
     */
    List<ChatTurn> findByExecutionIds(Collection<Long> executionIds);

    /**
     * 按一批轮次 ID 批量取（历史接口一次 IN 装配 {@code turns} 字典）。
     *
     * <p>与 {@link #findByExecutionIds} 的区别只在查询列：读路径已经直接用消息行上的
     * {@code turn_id}，不再需要「执行 ID → 轮次」这一步映射。</p>
     */
    List<ChatTurn> findByIds(Collection<Long> turnIds);

    /**
     * 崩溃收尸：把「没有存活执行」的非终态轮次条件更新为失败终态。
     *
     * <p>与框架的 {@code markOrphanRunsFailed} 同口径：只命中 ACCEPTED / RUNNING
     * （对应框架的 CREATED / RUNNING）。**WAITING 不在条件内** —— 挂起是可恢复状态，
     * 误标失败会让用户再也恢复不了那次执行。</p>
     *
     * @return 被收口的行数
     */
    int markOrphansFailed(Instant completedAt);

    /** 取目标轮次及其之后的全部轮次，按主键升序（雪花主键单调递增，{@code id >= fromTurnId}）。 */
    List<ChatTurn> findFromId(Long sessionId, Long fromTurnId);

    /**
     * 历史分页：按主键倒序取最多 {@code limit} 条轮次（新 → 旧）。
     *
     * <p><b>分页单位从「消息行」改为「完整轮次」后的取数入口</b>。同一轮次的 USER / AI / TOOL 行
     * 必然整组落在同一页，前端不必再处理「同一轮横跨两页、需逐页累计后再聚合」。
     * 雪花主键单调递增，因此 {@code id < cursorTurnId} 即可靠地表达「更早的一轮」。</p>
     *
     * @param cursorTurnId 上一页最老一轮的 id；为空表示从最新一轮开始
     */
    List<ChatTurn> findLatest(Long sessionId, Long cursorTurnId, int limit);

    /**
     * 按一批会话 id 批量取**进行中**轮次（ACCEPTED / RUNNING / WAITING），一次 IN 查询。
     *
     * <p>bootstrap 用它补「历史分页取不到的活跃轮次」：已终结轮次走 {@code history.turns}，
     * 两者互补不重叠。WAITING 对应框架 SUSPENDED，是「可恢复」而非终态，必须算进行中 ——
     * 漏掉它前端就无法在刷新后恢复挂起卡片的轮次归属。不做 N+1。</p>
     */
    List<ChatTurn> findActiveBySessionIds(Collection<Long> sessionIds);

    /** 删除目标轮次及其之后的全部轮次，返回删除行数。只服务「重发」的会话回滚。 */
    int deleteFromId(Long sessionId, Long fromTurnId);
}
