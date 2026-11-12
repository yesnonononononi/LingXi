package com.summit.dp.session.application.port;

/**
 * 会话是否还有待发送输入。
 *
 * <p><b>为什么要有这个端口</b>：待发送队列由编排层（workflow）持有，而指令预测这类业务服务同样
 * 需要据它判断「用户下一句是否已经存在」。业务模块直接引用编排层是反向依赖，所以这里只暴露一个
 * 只读判定，由编排层的队列实现。</p>
 *
 * <p><b>为什么只读</b>：入队、认领、暂停、取消都属于编排流程，业务侧只需要「有没有」这一个事实。</p>
 */
public interface PendingInputProbe {

    /**
     * 该会话是否还有排队中或已认领尚未落地的输入。
     *
     * @param sessionId 会话标识
     * @return 存在待发送输入时为 true
     */
    boolean hasPending(long sessionId);
}
