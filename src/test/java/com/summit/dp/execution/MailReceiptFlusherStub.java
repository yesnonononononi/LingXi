package com.summit.dp.execution;

import com.summit.core.agent.Execution;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.workflow.application.input.MailReceiptFlusher;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.mockito.Mockito.mock;

/**
 * 显式测试装配：记录 flush 调用，不做真实写库。
 *
 * <p>{@link com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository} 的邮件回执协作方是
 * 必需依赖，直接 {@code new} 仓储的用例必须显式给出它 —— 不允许「缺省就跳过」的生产语义。</p>
 */
public class MailReceiptFlusherStub extends MailReceiptFlusher {

    private final AtomicInteger flushes = new AtomicInteger();
    private final List<Execution> flushed = new CopyOnWriteArrayList<>();

    public MailReceiptFlusherStub() {
        super(mock(EmailMessageReceiptRepository.class), mock(EmailMessageRepository.class));
    }

    @Override
    public void flush(Execution execution) {
        this.flushes.incrementAndGet();
        this.flushed.add(execution);
    }

    /** 被调用过几次（用于断言「保存路径确实经过回执协作方」）。 */
    public int flushCount() {
        return this.flushes.get();
    }

    /** 是否对某个执行调用过（断言保存时把执行交给了协作方）。 */
    public boolean wasFlushed(Execution execution) {
        return this.flushed.stream().anyMatch(item -> item == execution
                || (item.getId() != null && item.getId().equals(execution.getId())));
    }
}
