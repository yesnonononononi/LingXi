package com.summit.dp.agent.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.api.request.ChatRequest;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
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

    public ChatController(ChatService chatService) {
        this.chatService = chatService;
    }

    @Operation(summary = "文本交流")
    @PostMapping(value = "/completion", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<String> chat(
            @ModelAttribute ChatRequest chatRequest
            ){
        return chatService.chat(command(chatRequest));
    }

    /**
     * 受理聊天请求：请求线程同步落库后立即返回，模型调用异步进行，不建立任何 emitter。
     *
     * <p>实时事件一律由会话级订阅（{@code GET /a/completion/{sessionId}/events}）承载 ——
     * 旧的请求级流入口（{@code POST /completion/stream}）已随「单一会话级流」删除。</p>
     */
    @Operation(summary = "受理聊天请求（同步落库，异步执行，不建流）")
    @PostMapping(value = "/completion/commands", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ChatAcceptanceVO> acceptCommand(@ModelAttribute ChatRequest chatRequest) {
        return chatService.acceptCommand(command(chatRequest));
    }

    /**
     * 重发：按 checkpoint 编辑当时那条提问再发一次。
     *
     * <p>{@code messageId} 指明改哪条历史提问，{@code input} 是新内容；该轮及其之后的历史会被作废。
     * 与 {@link #acceptCommand} 同形态：同步受理、异步执行、不建流。</p>
     */
    @Operation(summary = "编辑历史提问后重发（同步受理）")
    @PostMapping(value = "/completion/resend", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ChatAcceptanceVO> resend(@ModelAttribute ChatRequest chatRequest) {
        return chatService.resend(command(chatRequest));
    }

    /**
     * 订阅会话事件流：前端切回某个会话时用它重新挂载。
     *
     * <p>只投递挂上之后的事件。切走期间的缺口由前端回查会话历史对齐 ——
     * 服务端不做回放，实时通道与历史接口各管一段，不重复承担一致性。</p>
     */
    @Operation(summary = "订阅会话事件流（切回会话时重新挂载）")
    @GetMapping(value = "/completion/{sessionId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter subscribe(@PathVariable Long sessionId) {
        return chatService.subscribeSession(sessionId);
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
