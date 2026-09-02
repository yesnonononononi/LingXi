package com.summit.dp.agent.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.api.dto.ChatRequest;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.AgentService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/a")
@Tag(name = "agent接口",description = "项目agent入口")
public class AgentController {
    private final AgentService agentService;

    public AgentController(AgentService agentService) {
        this.agentService = agentService;
    }

    @Operation(summary = "文本交流")
    @PostMapping("/chat")
    public Result<String> chat(
            @RequestBody ChatRequest chatRequest
            ){
        return agentService.chat(new ChatCommand(chatRequest.input(), chatRequest.sessionId(), chatRequest.workDir(), chatRequest.workspaceId()));
    }

    @Operation(summary = "流式交流(SSE)")
    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter chatStream( @RequestBody ChatRequest chatRequest
    ) {
        return agentService.chatStream(new ChatCommand(chatRequest.input(), chatRequest.sessionId(), chatRequest.workDir(), chatRequest.workspaceId()));
    }
}
