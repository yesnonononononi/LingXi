package com.summit.dp.model.Infrastructure.config;

import lombok.Getter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 压缩参数的只读快照（启动期绑定，改值需改 yaml 并重启）。
 *
 * <p>业务侧不持有压缩策略：阈值与尝试次数归框架的
 * {@code lingxi.agent.runtime.tool.context-compact.*}，压缩模型的输出上限归
 * {@code lingxi.agent.model.conf.compact.max-tokens}。这里把同一批键读出来供设置页展示，
 * 让页面数字与运行时真值同源，而不是前端再抄一份默认值。
 */
@Getter
@Component
public class CompactionProperties {

    private final double modelThreshold;
    private final Integer maxSummaryAttempts;
    private final int compactMaxTokens;

    public CompactionProperties(
            @Value("${lingxi.agent.runtime.tool.context-compact.model-threshold:0.85}") double modelThreshold,
            @Value("${lingxi.agent.runtime.tool.context-compact.max-summary-attempts:#{null}}") Integer maxSummaryAttempts,
            @Value("${lingxi.agent.model.conf.compact.max-tokens:32768}") int compactMaxTokens) {
        this.modelThreshold = modelThreshold;
        this.maxSummaryAttempts = maxSummaryAttempts;
        this.compactMaxTokens = compactMaxTokens;
    }
}
