package com.summit.dp.agent.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface AgentService {
    Result<String> chat(ChatCommand command);

    SseEmitter chatStream(ChatCommand command);
}
