package com.summit.dp.agent.api.controller;

import com.summit.dp.agent.application.service.impl.AgentService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/agent")
public class AgentController {
    private final AgentService agentService;

    @GetMapping("/chat")
    public String chat(){
        return agentService.chat();
    }
}
