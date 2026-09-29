package com.summit.dp.agent.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.api.dto.ChatRequest;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
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

    @Operation(summary = "流式交流(SSE)")
    @PostMapping(value = "/completion/stream", consumes = MediaType.MULTIPART_FORM_DATA_VALUE,
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter chatStream( @ModelAttribute ChatRequest chatRequest
    ) {
        return chatService.chatStream(command(chatRequest));
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
        return new ChatCommand(request.input(), request.sessionId(), request.modelId(), request.workspaceId(),
                request.agentId(), Objects.requireNonNullElse(request.requirePlan(), false),
                request.image(), request.imageUrl()
        );
    }
}
