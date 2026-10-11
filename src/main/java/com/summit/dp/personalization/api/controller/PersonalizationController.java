package com.summit.dp.personalization.api.controller;

import com.summit.ddd.application.vo.Result;

import com.summit.dp.personalization.api.request.PersonalizationRequest;
import com.summit.dp.personalization.application.command.PersonalizationCommand;
import com.summit.dp.personalization.application.service.PersonalizationService;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.application.vo.ReplyStyleVO;

import lombok.RequiredArgsConstructor;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Personalization 接口层（生成骨架）
 */
@RestController
@RequestMapping("/personalization")
@RequiredArgsConstructor
public class PersonalizationController {
    private final PersonalizationService service;

    @GetMapping("/current")
    public Result<PersonalizationVO> current() {
        return service.current();
    }

    @GetMapping("/find/{id}")
    public Result<PersonalizationVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody PersonalizationRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/reply-styles")
    public Result<List<ReplyStyleVO>> listReplyStyles() {
        return service.listReplyStyles();
    }

    private PersonalizationCommand toCommand(PersonalizationRequest request) {
        return PersonalizationCommand.builder()
                .id(request.getId())
                .replyStyle(request.getReplyStyle())
                .title(request.getTitle())
                .commonAgentName(request.getCommonAgentName())
                .customInstruction(request.getCustomInstruction())
                .build();
    }

}
