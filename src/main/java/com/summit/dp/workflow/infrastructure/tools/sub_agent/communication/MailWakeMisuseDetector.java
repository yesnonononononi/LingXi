package com.summit.dp.workflow.infrastructure.tools.sub_agent.communication;

import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;

/**
 * 判定一次发信是不是「主理人拿邮件当唤醒/催办通道」的误用，供发信回执追加提醒。
 *
 * <p><b>为什么要在回执里提醒</b>：邮件没有唤醒语义 —— 只有协作根执行会驻留等待，队员结束即
 * 终态、不再被任何消息唤醒。主理人若用邮件叫一个已收工的队员做事，那封信只会永久停在待处理，
 * 而回执照旧报「已投递」，模型据此以为已经安排下去了。提示词里的禁令是软约束，这里补一次
 * 运行期反馈。</p>
 *
 * <p><b>判据两条，缺一都不是本提醒的适用面</b>：①发送方是根执行（根执行没有
 * {@code ROOT_EXECUTION_ID}，即主理人本人）；②收件 Agent 在本次协作里没有任何未终结执行
 * （含「从未被委派」）。队员仍在跑时邮件是有效通道，成员之间的通信也不在此列。</p>
 */
@Component
@RequiredArgsConstructor
public class MailWakeMisuseDetector {

    private final SessionRepository sessionRepository;
    private final ExecutionLocator executionLocator;

    /**
     * @param attributes    发信执行的受控属性
     * @param toAgentId     收件 Agent id
     * @param rootSessionId 邮箱业务键（协作根会话 id）
     * @return 提醒文案；不构成误用时为空
     */
    public Optional<String> detect(Map<String, Object> attributes, Long toAgentId, Long rootSessionId) {
        // 1, 只有根执行（主理人）发信才谈得上「用邮件唤醒队员」；成员发信不在适用面内。
        if (ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID) != null) {
            return Optional.empty();
        }

        Long senderAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        if (toAgentId == null || rootSessionId == null || toAgentId.equals(senderAgentId)) {
            return Optional.empty();
        }

        // 2, 查无子会话 = 该 Agent 本次协作里从未被委派；有子会话但无未终结执行 = 已收工。
        //    两种情形那封信都没人马上读，提醒一致。
        Optional<Long> subSessionId = sessionRepository.findByRootAndAgent(rootSessionId, toAgentId)
                .map(Session::getId);
        if (subSessionId.isPresent() && !executionLocator.activeExecutionIds(subSessionId.get()).isEmpty()) {
            return Optional.empty();
        }

        return Optional.of(String.format(
                "注意：你正在尝试以不正确的方式委派并唤醒成员 —— agent %d 当前没有在运行的执行，"
                        + "这封邮件不会被读到。队员结束执行后即终态，不会再被任何消息唤醒；"
                        + "要它做事请改用 call_sub_agent 委派。", toAgentId));
    }
}
