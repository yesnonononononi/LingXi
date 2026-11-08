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
 * <p><b>权威判据必须落在会话级共享资源上，不能是执行私有属性</b>：消息追加进上下文之后、
 * 检查点落库之前存在崩溃窗口。执行每轮新建，把「已投递」记在执行属性里的判据在下一轮就丢了
 * （新建执行 / 重发 / 旧检查点三条真实入口都会因此重放历史）；把它当唯一事实，还会在
 * 「全局消费已生效、检查点没落库」的窗口里永久吞掉输入。</p>
 *
 * <p>邮件的做法是回执表（{@code email_message_receipt}）+ 检查点同事务提交：
 * 回执是逐条认领的权威事实，执行属性里的登记只用于同一轮内去重。
 * {@code pollPendingItems} 也不得按「已消费状态」过滤 —— 那正是窗口丢输入的成因。</p>
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
     * 只读探测：不认领、不消费。
     *
     * <p>收尾驻留判定与批次签名只需要「有没有 / 是什么」，不能顺手把投递权拿走 ——
     * 否则一次只读探测就会占住租约，真正要注入的那一轮反而拿不到输入。
     * 默认与轮询同义；会认领的实现必须覆盖它。</p>
     */
    default List<T> peekPendingItems(Execution execution) {
        return pollPendingItems(execution);
    }

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
     * <p>与 {@link #markConsumed} 分开是有意的：权威事实（游标/回执）必须能被信任，
     * 全局清理是副作用，失败只影响展示态。合并成一个方法，要么让清理失败拖垮整轮，
     * 要么让权威事实被一起吞掉。</p>
     */
    default void cleanupAfterConsume(Execution execution, List<T> items) {
        // 多数通道没有全局副作用。
    }

    /** 该会话是否仍有未完结的上游异步依赖（例如仍在跑的子代理或后台任务）。 */
    default boolean hasOpenAsyncDependency(Execution execution) {
        return false;
    }
}
