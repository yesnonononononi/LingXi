package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 邮件通道：协作信箱里到达的消息。
 *
 * <h2>文本协议两段都要逐字保留</h2>
 *
 * <p>循环内注入那段带「收件对象 / 注意事项」，跨轮次续跑那段是「成员 @x 发来消息」——
 * 它们本来就是给模型看的两份不同话术，改造只许把它们收到一处，不许改写措辞。</p>
 *
 * <h2>消费判据与崩溃窗口（本通道的核心取舍）</h2>
 *
 * <p>改造前是「先 {@code consumePendingItems} 全局标已消费，再把消息追加进上下文」，
 * 而检查点由框架在轮末保存。于是崩溃窗口里输入永久丢失：库里已消费，重启后查不到。</p>
 *
 * <p>现在权威判据是 {@code LAST_MAIL_ID}（随检查点持久化），{@code consumePendingItems}
 * 降级为<b>尽力而为的清理</b>。两条要求不能同时满足 ——「全局消费成功」与「检查点未落库」
 * 并存时，无论怎么做都有代价 —— 本实现选择<b>不丢输入</b>：轮询按 id 游标取、
 * 不按消费状态过滤，因此那种窗口里重启会重复注入一次，而不是丢一次。
 * 重复注入的代价是多一段上下文，丢一次输入的代价是协作方的新需求被静默吞掉，
 * 后者不可接受。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MailInputChannel implements PendingInputChannel<EmailMessageVO> {

    /** 邮件晚于恢复补充、早于子执行结果：协作方的新需求先于收尾判定被读到。 */
    public static final int ORDER = -800;

    private final EmailService emails;

    @Override
    public int order() {
        return ORDER;
    }

    /**
     * 邮件由协作方随时投递，本进程无从证明「没有新邮件」，所以永远要查。
     *
     * <p>这里是刻意保守的：若为了省一次查询返回 {@code false}，就会漏掉外部投递。</p>
     */
    @Override
    public boolean mightHavePending(Execution execution) {
        return true;
    }

    @Override
    public List<EmailMessageVO> pollPendingItems(Execution execution) {
        Long mailbox = ExecutionAttributes.mailboxSessionId(InputAutomationPolicy.attributes(execution));
        Long recipient = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution),
                ExecutionAttributes.AGENT_ID);
        if (mailbox == null || recipient == null) {
            return List.of();
        }
        List<EmailMessageVO> items = emails.pendingItemsAfter(mailbox, recipient, cursor(execution));
        // 空结果与 null 同等对待：任何一侧都不该被当成「有新邮件」。
        return items == null ? List.of() : items;
    }

    @Override
    public List<String> formatForModelContext(Execution execution, List<EmailMessageVO> items, InputInjectionStage stage) {
        Long recipient = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution), ExecutionAttributes.AGENT_ID);
        return items.stream().map(item -> stage == InputInjectionStage.CONTINUATION
                ? continuationText(item)
                : loopText(item, recipient)).toList();
    }

    @Override
    public void markConsumed(Execution execution, List<EmailMessageVO> items) {
        if (items.isEmpty()) {
            return;
        }
        long newest = cursor(execution);
        for (EmailMessageVO item : items) {
            if (item.getId() != null) {
                newest = Math.max(newest, item.getId());
            }
        }
        InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.LAST_MAIL_ID, newest);
    }

    @Override
    public void cleanupAfterConsume(Execution execution, List<EmailMessageVO> items) {
        if (items.isEmpty()) {
            return;
        }
        try {
            emails.consumePendingItems(items);
        } catch (RuntimeException failure) {
            // 尽力而为：清理失败只影响信箱的未读态，不影响「已注入」这一事实（判据是游标）。
            log.warn("信箱清理失败，注入事实不受影响: executionId={}, count={}, error={}",
                    execution.getId(), items.size(), failure.toString());
        }
    }

    /** 循环内话术：与改造前逐字一致，含「收件对象 / 注意事项」。 */
    private String loopText(EmailMessageVO item, Long recipientAgentId) {
        return String.format("""
                @%s 发来协作消息: \n
                %s
                收件对象: @%s \n
                注意事项: 此邮件仅补充背景，不替代当前执行的委派任务。处理或回复邮件后，请继续完成当前委派；仅回复邮件不代表委派完成。
                """, item.getSenderId(), item.getContent(), recipientAgentId);
    }

    /** 跨轮次续跑话术：与改造前逐字一致（换行与全角冒号都不能动）。 */
    private String continuationText(EmailMessageVO item) {
        return "成员 @" + item.getSenderId() + " 发来消息：\n" + item.getContent() + "\n";
    }

    private long cursor(Execution execution) {
        Long lastId = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution),
                ExecutionAttributes.LAST_MAIL_ID);
        return lastId == null ? 0L : lastId;
    }
}
