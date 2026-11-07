package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;

import java.util.List;

/**
 * 待处理外部输入通道：查询、格式化、消费三件事只有一个实现来源。
 *
 * <p><b>为什么要有共同协议</b>：同一个概念（「外部有新输入到达」）原来有三套平行机制 ——
 * 循环内拦截器各写一份格式化与消费、终态跨轮次续跑再写一份、启动唤醒又按另一套判据探测。
 * 同一封邮件的文本因此存在两份拼装代码，消费点也存在两处，崩溃窗口里谁先谁后没有统一答案。</p>
 *
 * <p><b>为什么不是一个大拦截器</b>：拦截器是框架扩展点，规范要求一个模块一个实现。
 * 合并之后 {@code catchErr()} 只能取一个值，而三个模块的取值语义不同（当前都是 {@code false}，
 * 即取信失败必须让整轮失败）。所以协议在这里统一，拦截器仍按模块保留薄壳。</p>
 *
 * <h2>消费判据的边界（本协议最重要的一条）</h2>
 *
 * <p><b>权威判据是随检查点持久化的游标，{@link #markConsumed} 里的全局副作用只是清理</b>。
 * 原因：消息追加进上下文之后、检查点落库之前存在崩溃窗口。若把「全局已消费」当权威判据，
 * 崩溃后重启会因为库里已消费而永远看不到这条输入 —— 输入被永久吞掉。
 * 反过来把游标当权威判据，最坏情况只是重复注入一次。</p>
 *
 * <p><b>为什么 {@code pollPendingItems} 不按「已消费」过滤</b>：这两条要求（全局消费成功、游标未推进）
 * 不能同时成立。本协议的取舍是<b>不丢优先</b>：轮询按「游标之后的全部输入」取，
 * 与全局消费状态无关，因此即便全局消费已生效而检查点没落库，重启仍能重新取到这一批，
 * 代价是重复注入一次。为此邮件通道改用「按 id 游标取」的查询，不再依赖「未读」状态。</p>
 *
 * @param <T> 该通道的输入项类型
 */
public interface PendingInputChannel<T> {

    /**
     * 注入优先级，数值越小越先注入上下文。
     *
     * <p>顺序即语义：补充要求（-850）是用户对当前轮的追加说明，必须先于协作邮件；
     * 邮件（-800）是协作方的新需求；子执行结果（-700）只做未完结依赖判定；
     * 后台任务结果（-650）是本地命令的产物，排在最后。</p>
     */
    int order();

    /**
     * 快速门禁：能否<b>证明</b>该执行没有新输入。
     *
     * <p>返回 {@code false} 表示「已证明没有新输入」，可以跳过查库；返回 {@code true}
     * 表示「可能有」，必须查。实现方必须把「证明不了」当成 {@code true}，
     * 否则冷启动/重启这类无从判断的场合会漏掉输入。</p>
     */
    default boolean mightHavePending(Execution execution) {
        return true;
    }

    /** 查询该执行尚未消费的输入项（按游标，不按全局消费状态）。 */
    List<T> pollPendingItems(Execution execution);

    /**
     * 格式化为注入模型的文本块，每个元素对应一条消息。
     *
     * <p>循环内注入与终态跨轮次续跑共用本方法，只按 {@code stage} 取不同的文本协议：
     * 历史协议的差异（例如邮件的「收件对象 / 注意事项」只出现在循环内）必须逐字保留。</p>
     */
    List<String> formatForModelContext(Execution execution, List<T> items, InputInjectionStage stage);

    /** 默认实现：按循环内协议转成用户消息并标记可压缩。 */
    default List<UserMessageEntity> toModelMessages(Execution execution, List<T> items, InputInjectionStage stage) {
        return formatForModelContext(execution, items, stage).stream()
                .map(text -> UserMessageEntity.from(text).markPendingCompaction())
                .toList();
    }

    /**
     * 推进游标（权威，随检查点持久化）并做尽力而为的全局清理。
     *
     * <p>实现必须保证：本方法<b>没有执行</b>时，重启后仍会因游标未推进而重新注入；
     * 本方法<b>执行了</b>但检查点没落库时，重启也不会丢输入（见类型注释）。</p>
     */
    void markConsumed(Execution execution, List<T> items);

    /**
     * 消费后的全局清理（例如把信箱消息标为已读）：尽力而为，失败不影响注入事实。
     *
     * <p>与 {@link #markConsumed} 分开是有意的：游标推进是权威事实，必须能被信任；
     * 全局清理是副作用，失败只影响展示态。合并成一个方法，要么让清理失败拖垮整轮，
     * 要么让游标推进被一起吞掉。</p>
     */
    default void cleanupAfterConsume(Execution execution, List<T> items) {
        // 多数通道没有全局副作用。
    }

    /** 该会话是否仍有未完结的上游异步依赖（例如仍在跑的子代理或后台任务）。 */
    default boolean hasOpenAsyncDependency(Execution execution) {
        return false;
    }
}
