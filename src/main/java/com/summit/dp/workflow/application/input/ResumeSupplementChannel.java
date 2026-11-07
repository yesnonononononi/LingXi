package com.summit.dp.workflow.application.input;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 恢复补充通道：把「用户在执行挂起期间补充的要求」注入上下文。
 *
 * <h2>门禁：只有能证明「没有新补充」时才允许零查库</h2>
 *
 * <p>改造前每一轮模型调用都无条件查两次库：{@code turns.findByExecutionId}（拿 sessionId/turnId）
 * 与 {@code messages.findResumeSupplements}（拿补充消息）。正常连续推理的轮次里这两次查询
 * 永远是空的，属于纯浪费。</p>
 *
 * <p>门禁判据是<b>两个不同来源的事实相减</b>：</p>
 * <ul>
 *   <li>检查点里的游标 {@code LAST_RESUME_SUPPLEMENT_ID}：已消费到哪一条；</li>
 *   <li>进程内脏版本 {@link ResumeSupplementVersionRegistry}：本进程已知的最新一条。</li>
 * </ul>
 *
 * <p><b>为什么不能「没有版本就跳过」</b>：旧检查点可能早于补充提交（检查点是轮末保存的），
 * 冷启动时进程内也没有版本表。这两种情况下「版本表为空」不代表「没有新补充」，
 * 恰恰相反 —— 恰恰是最可能有新补充的时候。所以只有
 * {@code 已知最新 > 游标} 或 {@code 已知最新 <= 游标} 这种<b>能比较</b>的情形才允许跳过查询：
 * 前者必须查，后者才能跳过；版本表里根本没有这个执行时，必须回退查库一次。</p>
 *
 * <p><b>轮次查询也纳入同一道门禁</b>：{@code turns.findByExecutionId} 同样在热路径上。
 * 这里不为它单独做 execution→turn 缓存 —— 缓存需要与执行同生命周期、还要能被重启后重新验证，
 * 而把「需不需要查」交给门禁已经能做到零查库，多一层缓存只多一处可能不一致。</p>
 */
@Component
@RequiredArgsConstructor
public class ResumeSupplementChannel implements PendingInputChannel<SessionMessage> {

    /** 恢复补充排在最前：它是用户对当前轮次的追加说明，必须先于协作邮件被读到。 */
    public static final int ORDER = -850;

    private final MessageRepository messages;
    private final ChatTurnService turns;
    private final ObjectMapper json;
    private final ResumeSupplementVersionRegistry versions;

    @Override
    public int order() {
        return ORDER;
    }

    @Override
    public boolean mightHavePending(Execution execution) {
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) {
            return true;
        }
        Long known = versions.latestKnown(executionId);
        if (known == null) {
            // 证明不了（冷启动 / 重启 / 被 LRU 挤掉）：必须查一次，否则会漏掉新输入。
            return true;
        }
        return known > cursor(execution);
    }

    @Override
    public List<SessionMessage> pollPendingItems(Execution execution) {
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) {
            return List.of();
        }
        long lastId = cursor(execution);
        ChatTurn turn = turns.findByExecutionId(executionId).orElse(null);
        if (turn == null) {
            // 没有轮次就没有「补充到哪一轮」这回事；把结论记下来，后续轮次不再重复查。
            versions.remember(executionId, lastId);
            return List.of();
        }
        List<SessionMessage> pending = new ArrayList<>();
        long newest = lastId;
        for (SessionMessage record : messages.findResumeSupplements(turn.getSessionId(), turn.getId())) {
            if (record.getId() == null) {
                continue;
            }
            if (record.getId() > lastId) {
                pending.add(record);
                newest = Math.max(newest, record.getId());
            }
        }
        // 查完就把「此刻最新一条」记回来：下一次拦截据此直接跳过查库。
        versions.remember(executionId, newest);
        return pending;
    }

    /**
     * 补充消息是已保存的实体 JSON，必须整体反序列化后再注入 —— 用 {@code from(text)} 会把它
     * 变成一个纯文本消息，丢掉原有属性。
     */
    @Override
    public List<UserMessageEntity> toModelMessages(Execution execution, List<SessionMessage> items, InputInjectionStage stage) {
        List<UserMessageEntity> result = new ArrayList<>();
        for (SessionMessage record : items) {
            result.add(parse(record));
        }
        return result;
    }

    @Override
    public List<String> formatForModelContext(Execution execution, List<SessionMessage> items, InputInjectionStage stage) {
        return items.stream().map(SessionMessage::getText).toList();
    }

    /** 游标是权威判据：推进它意味着「这一批已经进过上下文」，随检查点一起持久化。 */
    @Override
    public void markConsumed(Execution execution, List<SessionMessage> items) {
        if (items.isEmpty()) {
            return;
        }
        long newest = cursor(execution);
        for (SessionMessage record : items) {
            if (record.getId() != null) {
                newest = Math.max(newest, record.getId());
            }
        }
        InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.LAST_RESUME_SUPPLEMENT_ID, newest);
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId != null) {
            versions.remember(executionId, newest);
        }
    }

    private long cursor(Execution execution) {
        Long lastId = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution),
                ExecutionAttributes.LAST_RESUME_SUPPLEMENT_ID);
        return lastId == null ? 0L : lastId;
    }

    private UserMessageEntity parse(SessionMessage record) {
        try {
            return json.readValue(record.getText(), UserMessageEntity.class);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("读取已保存的补充要求失败", error);
        }
    }
}
