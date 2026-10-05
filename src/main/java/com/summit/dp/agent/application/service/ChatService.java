package com.summit.dp.agent.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.vo.AgentVO;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface ChatService {
    Result<String> chat(ChatCommand command);

    SseEmitter chatStream(ChatCommand command);

    /**
     * 重发：按 checkpoint（{@code messageId} 指明的历史提问）编辑当时输入后重跑，该轮及其之后的历史作废。
     */
    SseEmitter resend(ChatCommand chatCommand);
    /**
     * 订阅会话的实时事件流 —— 纯粹的挂载入口，不产生任何执行。
     *
     * <p>与 {@link #chatStream} 的区别：那条流属于「本次发消息」这一次请求，执行结束就 complete；
     * 前端切走再切回时它已经不存在了。本方法让前端在任意时刻（重新）挂到会话上。</p>
     *
     * <p>只投递<b>此刻之后</b>的事件，不回放历史 —— 切走期间的缺口由前端回查会话历史对齐
     * （见 {@code SseEventPublisher} 的类注释）。</p>
     *
     * @param sessionId 会话标识；子会话会自动归到它的根会话，与推送路由同一口径
     */
    SseEmitter subscribeSession(Long sessionId);

    /** 不可恢复地终止该根会话当前运行的主 loop 与全部子 loop。 */
    void stop(Long sessionId);

    /** 协作式暂停当前正在运行的 loop；已结束的执行不接受暂停。 */
    void suspend(Long sessionId);

    /** Resume the latest suspended execution of this session from its checkpoint. */
    Result<String> resume(Long sessionId);

}
