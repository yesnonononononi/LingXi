package com.summit.dp.email.domain.port;

/**
 * 邮件投递归属的持有者存活判定（领域端口）。
 *
 * <p>「谁还持有投递权」不能靠猜：能证明持有者未结束就绝不接管，与租约年龄无关。
 * 实现放在基础设施侧（workflow 的执行登记表），邮件域只依赖本接口。</p>
 */
public interface MailClaimLiveness {

    /**
     * 持有者是否仍未结束。
     *
     * <p>运行中与<b>挂起</b>都算活（挂起期间没有检查点提交，恢复后会继续确认交付）；
     * 已结束、已取消、未登记都算已消失。</p>
     *
     * @param executionId 持有投递权的执行 id
     * @return 未结束返回 {@code true}
     */
    boolean isHolderAlive(String executionId);

    /**
     * 该执行在当前进程里是否仍有登记。
     *
     * <p>冷启动之后一律为 {@code false}：这时无从判断对方是否还活着，只能交给墙钟兜底。</p>
     *
     * @param executionId 持有投递权的执行 id
     * @return 仍有登记返回 {@code true}
     */
    boolean isHolderRegistered(String executionId);
}
