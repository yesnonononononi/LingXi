package com.summit.dp.workflow.application.chat;

import com.summit.ddd.application.vo.Result;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface ChatService {
    Result<String> chat(ChatCommand command);

    /** 空闲时同步受理并返回轮次 ID，繁忙时返回待发送 ID。 */
    Result<ChatAcceptanceVO> acceptCommand(ChatCommand command);

    PendingChatQueue.Snapshot pendingCommands(long sessionId);

    void cancelPendingCommand(long sessionId, String pendingId);

    void resumePendingCommands(long sessionId);

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

    /** 恢复必须读取已提交的挂起检查点，不能重建执行身份。 */
    Result<String> resume(Long sessionId);

}
