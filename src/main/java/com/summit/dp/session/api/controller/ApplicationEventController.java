package com.summit.dp.session.api.controller;

import com.summit.dp.session.infrastructure.stream.ApplicationEventStream;
import com.summit.dp.session.application.service.SessionService;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.vo.SessionVO;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/application")
@RequiredArgsConstructor
public class ApplicationEventController {
    private final ApplicationEventStream stream;
    private final SessionService sessionService;

    @GetMapping("/sessions")
    public Result<List<SessionVO>> sessions() {
        return sessionService.applicationStates();
    }

    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events() {
        return stream.connect();
    }
}
