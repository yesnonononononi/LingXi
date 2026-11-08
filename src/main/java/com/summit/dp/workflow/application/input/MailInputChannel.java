package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 邮件通道：协作信箱里到达的消息。
 *
 * <h2>文本协议两段都要逐字保留</h2>
 *
 * <p>循环内注入那段带「收件对象 / 注意事项」，跨轮次续跑那段是「成员 @x 发来消息」——
 * 它们本来就是给模型看的两份不同话术，改造只许把它们收到一处，不许改写措辞。</p>
 *
 * <h2>消费判据：全局回执，不是执行私有游标</h2>
 *
 * <p>上一版把「已投递」记在执行属性（{@code LAST_MAIL_ID} 游标）。信箱是会话级共享资源、
 * 执行每轮新建，于是新建执行 / 重发 / 旧检查点这三条真实入口都没有该属性，游标缺省 0，
 * 整段历史邮件被重放；而且 {@code max(mailId)} 高水位并不等于提交顺序，较小 id 晚提交会被永久挡住。</p>
 *
 * <p>现在权威判据是 {@code email_message_receipt}：待处理 = 本邮箱下没有回执的邮件，与消息
 * {@code status}、与 id 大小都无关。本类只把「本轮已投递」记进执行属性
 * {@link ExecutionAttributes#DELIVERED_MAIL_IDS}（随检查点持久化），供同一轮内去重；
 * 真正的回执由 {@link MailReceiptFlusher} 在检查点提交的同一事务里落库。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
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
        List<EmailMessageVO> items = undelivered(execution);
        if (items.isEmpty()) {
            return List.of();
        }
        Long mailbox = ExecutionAttributes.mailboxSessionId(InputAutomationPolicy.attributes(execution));
        Long recipient = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution),
                ExecutionAttributes.AGENT_ID);
        List<EmailMessageVO> claimed = new ArrayList<>();
        for (EmailMessageVO item : items) {
            if (item.getId() == null) {
                continue;
            }
            // 逐条认领：拿不到投递权（已交付，或别人持有有效租约）就绝不注入，避免两份上下文各投一次。
            if (emails.claimDelivery(item.getId(), execution.getId())) {
                claimed.add(item);
            }
        }
        log.debug("邮件认领结果: mailbox={}, recipient={}, 候选={}, 取得={}",
                mailbox, recipient, items.size(), claimed.size());
        return claimed;
    }

    /** 只读探测：给出本邮箱里还没有交付回执的邮件，不认领。 */
    @Override
    public List<EmailMessageVO> peekPendingItems(Execution execution) {
        return undelivered(execution);
    }

    /** 本邮箱下没有已交付回执、且不在本轮已注入清单里的邮件（按 create_at, id 稳定排序）。 */
    private List<EmailMessageVO> undelivered(Execution execution) {
        Long mailbox = ExecutionAttributes.mailboxSessionId(InputAutomationPolicy.attributes(execution));
        Long recipient = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution),
                ExecutionAttributes.AGENT_ID);
        if (mailbox == null || recipient == null) {
            return List.of();
        }
        List<EmailMessageVO> items = emails.pendingItemsUndelivered(mailbox, recipient);
        if (items == null || items.isEmpty()) {
            return List.of();
        }
        // 同一轮内的去重：回执要等检查点提交才落库，这之前靠执行属性挡住重复注入。
        Set<Long> deliveredInRound = new LinkedHashSet<>(ExecutionAttributes.readLongs(
                InputAutomationPolicy.attributes(execution), ExecutionAttributes.DELIVERED_MAIL_IDS));
        if (deliveredInRound.isEmpty()) {
            return items;
        }
        return items.stream()
                .filter(item -> item.getId() == null || !deliveredInRound.contains(item.getId()))
                .toList();
    }

    @Override
    public List<String> formatForModelContext(Execution execution, List<EmailMessageVO> items, InputInjectionStage stage) {
        Long recipient = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(execution), ExecutionAttributes.AGENT_ID);
        return items.stream().map(item -> stage == InputInjectionStage.CONTINUATION
                ? continuationText(item)
                : loopText(item, recipient)).toList();
    }

    /**
     * 只登记「本轮已投递」的 id，不写库。
     *
     * <p>写库（回执 + 状态清理）必须与检查点同一事务，见 {@link MailReceiptFlusher}；
     * 在这里独立提交一次会造成「回执已落库、检查点没落库」的永久丢输入窗口。</p>
     */
    @Override
    public void markConsumed(Execution execution, List<EmailMessageVO> items) {
        if (items.isEmpty()) {
            return;
        }
        Set<Long> delivered = new LinkedHashSet<>(ExecutionAttributes.readLongs(
                InputAutomationPolicy.attributes(execution), ExecutionAttributes.DELIVERED_MAIL_IDS));
        List<Long> merged = new ArrayList<>(delivered);
        for (EmailMessageVO item : items) {
            if (item.getId() != null && delivered.add(item.getId())) {
                merged.add(item.getId());
            }
        }
        InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.DELIVERED_MAIL_IDS, List.copyOf(merged));
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
}
