package com.summit.dp.model.application.vo;

/**
 * 上下文压缩的可观测参数快照：全部来自配置项，设置页只读展示。
 *
 * <p>页面上的「高级设置」不是可编辑表单：这些值在框架启动期绑定，改它们要动 yaml 并重启，
 * 所以这里只提供真值，避免前端自己抄一份默认值后再与后端漂移。</p>
 */
public record CompactionParamsVO(
        /* 摘要触发阈值：上下文用量占预算的比例达到该值即开始压缩。 */
        double modelThreshold,
        /* 单个触发窗口内的摘要总尝试次数；null 表示框架缺省（只尝试一次）。 */
        Integer maxSummaryAttempts,
        /* 压缩模型最大输出 token 数。 */
        int compactMaxTokens
        ) {
}
