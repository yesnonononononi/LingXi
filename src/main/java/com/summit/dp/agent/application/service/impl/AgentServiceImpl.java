package com.summit.dp.agent.application.service.impl;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
@RequiredArgsConstructor
public class AgentServiceImpl implements AgentService {

    private final RestClient restClient;

    @Override
    public String chat() {
        return restClient.get()
                .uri("/agent/chat")
                .retrieve()
                .body(String.class);
    }
}
