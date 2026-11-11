package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 文件改动的查看作用域：一个会话 → 它所在整棵会话树的轮次标识。
 *
 * <p><b>为什么范围是整棵树</b>：子 Agent 的改动落在自己的会话下，但用户看的是同一个工作区里
 * 同一个文件。只查本会话会把子 Agent 刚改完的最新状态漏掉。</p>
 *
 * <p>解析放在这里而不是记录层：{@code file_record} 只认识 {@code turn_id}，
 * 会话表与轮次表各归各的模块。</p>
 */
@Component
@RequiredArgsConstructor
public class FileEditSceneScope {

    private final SessionRepository sessions;
    private final ChatTurnRepository turns;

    /**
     * 作用域内的轮次标识（字符串形态，与 {@code file_record.turn_id} 同形）。
     *
     * @throws ClientException 会话不存在（对外就是「已删除或失效」）
     */
    public List<String> resolveSceneTurnIds(long sessionId) {
        Session session = this.sessions.findById(sessionId)
                .orElseThrow(() -> new ClientException("会话不存在或已删除"));
        // 子会话要回到根：同一棵树下所有轮次都算「同一个文件的历史」。
        Long rootId = session.isSubSession() ? session.getRootSessionId() : session.getId();
        List<Long> treeSessionIds = this.sessions.findSessionTree(rootId).stream()
                .map(Session::getId)
                .toList();
        return this.turns.findIdsBySessionIds(treeSessionIds).stream()
                .map(String::valueOf)
                .toList();
    }
}
