package com.summit.dp.stream.application.service;

import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 快照该收哪些历史消息。
 *
 * <p><b>为什么独立</b>：保留规则里混着两件不同的事 —— 「这条消息所属轮次是否在保留集内」
 * 与「这条消息连轮次都没有（turnId 为空的历史数据）时按尾部窗口兜底」。后者是一个
 * 与业务语义无关的兼容分支，夹在装配流程中间会让主流程更难读：读者会以为
 * {@code turnId == null} 的消息也要参与轮次筛选。</p>
 */
@Component
@RequiredArgsConstructor
public class MessageRetainResolver {

    private final MessageRepository messages;

    /**
     * 挑出该保留的消息：轮次在保留集内的，以及尾部窗口内的无轮次消息。
     *
     * @param retained 本次快照保留的轮次 id
     */
    public List<SessionMessage> resolve(List<Session> tree, Set<Long> retained) {
        List<SessionMessage> selected = new ArrayList<>();
        for (Session session : tree) {
            List<SessionMessage> history = messages.findBySessionId(session.getId()).stream()
                    .filter(message -> message.getType() != SessionMessageType.SYSTEM).toList();
            int unknownStart = Math.max(0, history.size() - StreamSnapshotAssembler.RETAINED_COMPLETED_TURNS);
            for (int index = 0; index < history.size(); index++) {
                SessionMessage message = history.get(index);
                boolean retainedByTurn = retained.contains(message.getTurnId());
                // 无 turnId 的旧数据不在轮次筛选范围内，只靠尾部窗口兜底。
                boolean retainedByWindow = message.getTurnId() == null && index >= unknownStart;
                if (retainedByTurn || retainedByWindow) {
                    selected.add(message);
                }
            }
        }
        return selected;
    }
}