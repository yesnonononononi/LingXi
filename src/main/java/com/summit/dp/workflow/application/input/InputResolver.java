package com.summit.dp.workflow.application.input;

import cn.hutool.crypto.digest.DigestUtil;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 只归并当前事实，不记录通知，也不改变执行状态。
 *
 * <p><b>为什么依赖三个具体通道而不是 {@code List<PendingInputChannel<?>>}</b>：
 * 「有没有新输入到达、该不该自动唤醒」这个问题只属于会让执行重新跑起来的三类输入
 * （协作邮件、未回来的子代理、后台任务）。恢复补充不属于这里 —— 它是用户对<b>已挂起</b>
 * 执行的追加说明，提交成功后由 {@code ResumeSupplementService} 直接触发恢复，
 * 若也算进「新输入到达」，会给同一件事产生两条唤醒判据。</p>
 *
 * <p>顺序按各通道声明的 {@code order()} 固定，批次标识因此稳定可比。</p>
 */
@Component
@RequiredArgsConstructor
public class InputResolver {

    private final MailInputChannel mail;
    private final SubExecutionResultChannel subExecution;
    private final BackgroundTaskChannel backgroundTasks;
    private final ObjectMapper json;

    /** 注入顺序即语义顺序，与拦截器链路一致。 */
    private List<PendingInputChannel<?>> channels() {
        return List.of(mail, subExecution, backgroundTasks);
    }

    public String pendingBatchKey(Execution execution) {
        try {
            List<String> batches = new ArrayList<>();
            for (PendingInputChannel<?> channel : channels()) {
                List<?> items = channel.peekPendingItems(execution);
                if (!items.isEmpty()) {
                    batches.add(channel.getClass().getName() + ":" + json.writeValueAsString(items));
                }
            }
            return batches.isEmpty() ? null : DigestUtil.sha256Hex(String.join("\n", batches));
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("待处理输入无法生成批次标识", failure);
        }
    }

    public boolean hasPendingItems(Execution execution) {
        return channels().stream().anyMatch(channel -> !channel.peekPendingItems(execution).isEmpty());
    }

    public boolean hasOpenDependency(Execution execution) {
        return channels().stream().anyMatch(channel -> channel.hasOpenAsyncDependency(execution));
    }
}

