package com.summit.dp.session.application.port;

import com.summit.core.conversation.message.Message;

import java.util.Collection;
import java.util.List;

/**
 * 模型上下文正文的落盘端口。
 *
 * <p>正文不进库：{@code session_context} 只留正文标识。之所以必须外置，是因为正文每轮整笔替换，
 * 留在 CLOB 列里等于每轮让 H2 追加一份 LOB，而 MVStore 从不回退文件，库体积只涨不落。</p>
 *
 * <p><b>为什么每次写入都是新文件</b>：{@code replace} 有四条路径（回滚、审批落定、决策落库、
 * 执行收尾）本身就跑在外层事务里。文件名若恒定，事务回滚就会出现「库里引用还是旧的、磁盘内容
 * 已经是新的」——而旧实现里 content 列是跟着事务一起回滚的。每次写新标识、库里只换引用，
 * 回滚时旧文件仍是权威内容，天然一致。</p>
 */
public interface SessionContextStore {

    /**
     * 写入一份新正文并发布成可读文件。
     *
     * <p>发布用「临时文件 → fsync → 原子改名」完成，读者只会看到完整的某一版。</p>
     *
     * @param sessionId 会话标识
     * @param messages  本次要发布的完整上下文
     * @return 正文标识，写进库内引用
     * @throws IllegalStateException 落盘失败
     */
    String write(long sessionId, List<Message> messages);

    /**
     * 读取库内引用指向的那一份正文。
     *
     * @param sessionId 会话标识
     * @param bodyId    库内记录的正文标识
     * @return 按写入顺序还原的消息列表（可能是空列表）
     * @throws IllegalStateException 文件缺失或某一行无法解析；调用方必须看到失败，不能读成空历史
     */
    List<Message> read(long sessionId, String bodyId);

    /**
     * 删除一份正文（被替换掉的旧份、或本次写入回滚后的废份）。
     *
     * <p>删完顺手回收空目录；删不掉只是垃圾，不能影响已经提交的事实。</p>
     */
    void delete(long sessionId, String bodyId);

    /** 删除这些会话的全部正文（会话树删除时调用）；由调用方先删库行。 */
    void deleteSessions(Collection<Long> sessionIds);

    /**
     * 列出磁盘上已有正文目录的会话 id（只读目录名，不打开任何正文）。
     *
     * <p>孤儿清扫用它枚举候选：目录名不是数字的一律跳过 —— 那不是本实现的产物。</p>
     *
     * @param limit 单批上限
     */
    List<Long> listSessionIds(int limit);

    /**
     * 删除某个会话的整个正文目录，**但只在目录已经静止时**。
     *
     * <p>{@code idleBefore} 是安全线：目录里只要还有比它更新的文件，就说明可能有一次替换正在
     * 「已落盘、尚未换引用」的窗口里，此刻删文件会造出「库内引用指向不存在的正文」。
     * 孤儿清扫只删早已死掉的目录，等一轮不亏。</p>
     *
     * @param sessionId  会话 id
     * @param idleBefore 静止时间线（早于它才算静止）
     * @return 是否真的删掉了目录
     */
    boolean deleteSessionDirectory(long sessionId, java.time.Instant idleBefore);
}

