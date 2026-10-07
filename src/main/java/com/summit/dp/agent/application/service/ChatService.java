package com.summit.dp.agent.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface ChatService {
    Result<String> chat(ChatCommand command);

    /**
     * 受理一次聊天请求：请求线程同步落库（用户消息 + 业务轮次 + 执行行），模型调用随后异步进行。
     *
     * <p>本入口不建立任何 emitter，实时事件一律由会话级订阅（{@link #subscribeSession}）承载 ——
     * 流跟页面走，不跟「这一次发送」走。受理返回成功即代表这一轮已有了明确的落库依据，
     * 前端凭返回的 {@code sessionId} / {@code turnId} 对齐事件与历史。</p>
     *
     * @return 含 {@code sessionId} 与 {@code turnId} 的受理回执
     */
    Result<ChatAcceptanceVO> acceptCommand(ChatCommand command);

    /**
     * 重发：按 checkpoint（{@code messageId} 指明的历史提问）编辑当时输入后重跑，该轮及其之后的历史作废。
     *
     * <p>与 {@link #acceptCommand} 同形态：同步受理、异步执行、不建 emitter。</p>
     */
    Result<ChatAcceptanceVO> resend(ChatCommand chatCommand);
    /**
     * 订阅会话的实时事件流 —— 纯粹的挂载入口，不产生任何执行。
     *
     * <p>全系统只有这一条实时通道：流属于会话、不属于某一次发送，因此前端在任意时刻
     * （首次进入、切回会话）都能重新挂上或卸载，执行完成 / 失败 / 停止都不会关它。</p>
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
