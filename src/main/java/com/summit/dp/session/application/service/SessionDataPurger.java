package com.summit.dp.session.application.service;

import com.summit.dp.checklist.domain.repository.ChecklistRepository;
import com.summit.dp.execution.application.service.ExecutionSessionCleanupService;
import com.summit.dp.session.application.port.SessionImageCache;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Collection;

/**
 * 删掉一批会话名下的全部附属数据（不含会话行本身）。
 *
 * <p><b>为什么独立成类</b>：会话删除入口负责的是「顺序」—— 先查树、再问执行、再删会话行；
 * 而「这批会话到底牵动哪些表、哪些文件」是另一回知识，塞进入口会变成一个什么都干的巨型方法。
 * 这里只做一件事，且只被会话删除调用。</p>
 *
 * <p><b>为什么每一步都必须删</b>：轮次、任务、清单都是执行行「是否还有业务引用」的判据；
 * 工具卡片、审计、上下文、图片则按会话归属直接持有数据。漏掉任何一类，都会留下永不被回收的孤儿。</p>
 *
 * <p><b>文件一律提交后删</b>：检查点目录、上下文正文、图片目录都由各自模块登记
 * {@code afterCommit}；本类只保证「库里的行先走」。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SessionDataPurger {

    private final MessageRepository messages;
    private final ChatTurnRepository turns;
    private final TaskRepository tasks;
    private final ChecklistRepository checklists;
    private final SessionTokenAuditRepository tokenAudits;
    private final ToolCallRepository toolCalls;
    private final ExecutionSessionCleanupService executions;
    private final ModelContextService contexts;
    private final SessionImageCache images;

    /**
     * 清理这批会话的附属数据。
     *
     * <p>调用方必须已经确认这些会话没有正在跑的执行：删掉运行中执行的检查点行，
     * 线程收尾时会重新插一条指向已删会话的孤儿。</p>
     *
     * @param sessionIds 整棵会话树的会话 id；空入参直接返回
     */    public void purge(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        messages.batchDelBySessionIds(sessionIds.stream().toList());
        turns.deleteBySessionIds(sessionIds);
        tasks.deleteBySessionIds(sessionIds);
        checklists.deleteBySessionIds(sessionIds);
        tokenAudits.deleteBySessionIds(sessionIds);
        // 卡片按 conversation_id 归属：不删就是无界累积的孤儿卡片。
        toolCalls.deleteByConversationIds(sessionIds);
        // 执行侧自己管检查点目录：删行在这里，删目录在提交后。
        executions.deleteBySessions(sessionIds);
        // 上下文正文与引用行由它统一收口：库里删行、提交后删文件。
        contexts.deleteBySessionIds(sessionIds.stream().toList());
        // 图片以会话目录为单位：会话没了，目录里的哈希文件再无任何引用。
        images.deleteSessions(sessionIds);
        log.debug("会话附属数据已清理: sessionCount={}", sessionIds.size());
    }
}
