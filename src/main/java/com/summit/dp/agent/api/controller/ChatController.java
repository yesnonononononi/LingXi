package com.summit.dp.agent.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.api.request.ChatRequest;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.command.CommandChatRequest;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.service.impl.ChatCommandAcceptance;
import com.summit.dp.agent.application.vo.CommandAcceptanceVO;
import com.summit.dp.agent.application.vo.ResendCommandAcceptanceVO;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.stream.application.service.SessionStreamHub;
import com.summit.dp.execution.ExecutionIdentity;
import org.springframework.beans.factory.annotation.Autowired;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Objects;

@RestController
@RequestMapping("/a")
@Tag(name = "chat接口", description = "会话聊天入口")
public class ChatController {
    private final ChatService chatService;
    /** v2 受理入口；与 v1 SSE 入口并存，各自独立。 */
    private final ChatCommandAcceptance chatCommandAcceptance;
    @Autowired
    private SessionStreamHub streamHub;
    /** v3 直投发布器：schemaVersion=3 的订阅落到它上面（只登记连接 + 发 STREAM_READY）。 */
    @Autowired
    private EventStreamPublisher eventStreamPublisher;
    @Autowired
    private ExecutionIdentity executionIdentity;

    public ChatController(ChatService chatService, ChatCommandAcceptance chatCommandAcceptance) {
        this.chatService = chatService;
        this.chatCommandAcceptance = chatCommandAcceptance;
    }

    @Operation(summary = "文本交流")
    @PostMapping(value = "/completion", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<String> chat(
            @ModelAttribute ChatRequest chatRequest
            ){
        return chatService.chat(command(chatRequest));
    }

    @Operation(summary = "流式交流(SSE)")
    @PostMapping(value = "/completion/stream", consumes = MediaType.MULTIPART_FORM_DATA_VALUE,
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter chatStream( @ModelAttribute ChatRequest chatRequest
    ) {
        return chatService.chatStream(command(chatRequest));
    }

    /**
     * 重发：按 checkpoint 编辑当时那条提问再发一次。
     *
     * <p>{@code messageId} 指明改哪条历史提问，{@code input} 是新内容；该轮及其之后的历史会被作废。</p>
     */
    @Operation(summary = "编辑历史提问后重发(SSE)")
    @PostMapping(value = "/completion/resend", consumes = MediaType.MULTIPART_FORM_DATA_VALUE,
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter resend(@ModelAttribute ChatRequest chatRequest) {
        return chatService.resend(command(chatRequest));
    }

    /**
     * v2 发送受理：JSON 回执，不建 SSE 连接。
     *
     * <p><b>与 v1 的关系</b>：v1 的 {@code /completion/stream} 保留给旧前端，本入口不替代它。
     * 两条入口不得对同一条命令混用 —— 同一命令要么走这里（带 commandId、可重试），
     * 要么走 v1（无幂等），混用会让重试查不回首次受理。</p>
     */
    @Operation(summary = "发送消息（v2 受理回执）")
    @PostMapping(value = "/completion/commands", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<CommandAcceptanceVO> sendCommand(@ModelAttribute ChatRequest chatRequest,
                                                   @RequestParam String commandId) {
        return Result.success(chatCommandAcceptance.accept(
                new CommandChatRequest(command(chatRequest), commandId)));
    }

    /**
     * v2 重发受理：除新轮次身份外，还回被作废范围与新的 historyRevision。
     *
     * <p>破坏性操作（会物理删除目标轮次及其之后的历史），所以回执必须把作废范围说清楚，
     * 前端据此精确移除实体，而不是留下指向已删除数据的空壳。</p>
     */
    @Operation(summary = "编辑历史提问后重发（v2 受理回执）")
    @PostMapping(value = "/completion/resend/commands", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ResendCommandAcceptanceVO> resendCommand(@ModelAttribute ChatRequest chatRequest,
                                                            @RequestParam String commandId) {
        return Result.success(chatCommandAcceptance.acceptResend(
                new CommandChatRequest(command(chatRequest), commandId)));
    }

    /**
     * 订阅会话事件流：前端切回某个会话时用它重新挂载。
     *
     * <p>只投递挂上之后的事件。切走期间的缺口由前端回查会话历史对齐 ——
     * 服务端不做回放，实时通道与历史接口各管一段，不重复承担一致性。</p>
     *
     * <p><b>三条协议并存</b>：{@code schemaVersion=1} 走旧 v1 SSE；{@code =2} 走
     * {@link SessionStreamHub}（带投影累积）；{@code =3} 走 {@link EventStreamPublisher}
     * （只登记连接、不查库，首帧即 STREAM_READY，业务状态由前端随后 bootstrap 拉取，§8）。
     * 前端入口必须显式带 {@code ?schemaVersion=3}，否则落到默认值 1。</p>
     */
    @Operation(summary = "订阅会话事件流（切回会话时重新挂载）")
    @GetMapping(value = "/completion/{sessionId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter subscribe(@PathVariable Long sessionId,
                                @RequestParam(defaultValue = "1") int schemaVersion) {
        if (schemaVersion == 1) return chatService.subscribeSession(sessionId);
        if (schemaVersion == 2) return streamHub.subscribe(executionIdentity.resolveRootSessionId(sessionId));
        // v3 传入根会话：后端不按事件发送时重新解析，身份在订阅那一刻就固定。
        if (schemaVersion == 3) return eventStreamPublisher.subscribe(executionIdentity.resolveRootSessionId(sessionId));
        throw new IllegalArgumentException("不支持该流协议版本，请刷新客户端");
    }

    @Operation(summary = "停止当前会话及其全部子会话")
    @PostMapping("/completion/{sessionId}/stop")
    public void stop(@PathVariable Long sessionId) {
        chatService.stop(sessionId);
    }

    @Operation(summary = "暂停当前会话")
    @PostMapping("/completion/{sessionId}/suspend")
    public void suspend(@PathVariable Long sessionId) {
        chatService.suspend(sessionId);
    }

    @Operation(summary = "恢复当前会话最近暂停的执行")
    @PostMapping("/completion/{sessionId}/resume")
    public Result<String> resume(@PathVariable Long sessionId) {
        return chatService.resume(sessionId);
    }

    /** 请求 → 命令：计划能力是否下发由请求显式声明，后端不再按会话状态推断。团队按会话绑定取值。 */
    private static ChatCommand command(ChatRequest request) {
        return new ChatCommand(request.input(), request.sessionId(),
                request.modelId(),
                request.workspaceId(),
                request.messageId(),
                request.agentId(),
                Objects.requireNonNullElse(request.requirePlan(), false),
                request.image(), request.imageUrl()
        );
    }
}
