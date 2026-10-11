package com.summit.dp.personalization.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;

import com.summit.dp.personalization.application.command.PersonalizationCommand;
import com.summit.dp.personalization.application.service.PersonalizationService;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.model.Personalization;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;

import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * Personalization 应用层服务实现（生成骨架）
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PersonalizationServiceImpl implements PersonalizationService {

    private final PersonalizationRepository repository;

    @Override
    public Result<PersonalizationVO> findById(Long id) {
        if (id == null)
            return Result.error("id is null");
        Optional<Personalization> model = repository.findById(id);
        return model.map(m -> Result.success(toVO(m))).orElseGet(() -> Result.error("id 对应数据不存在"));
    }





    @Override
    public Result<Void> update(PersonalizationCommand command) {
        if (command == null || command.getId() == null)
            return Result.error("id is null");
        Personalization model = repository.findById(command.getId()).orElseThrow(() -> new ClientException("id 对应数据不存在"));
        repository.updateById(updateOf(command, model));
        return Result.success();
    }




    @Override
    public Result<List<String>> listReplyStyles() {
        return Result.success(Arrays.stream(ReplyStyle.values()).map(ReplyStyle::getDescription).toList());
    }

    private Personalization updateOf(PersonalizationCommand command, Personalization model) {
        String commonAgentName = command.getCommonAgentName();
        String customInstruction = command.getCustomInstruction();
        String replyStyle = command.getReplyStyle();
        String title = command.getTitle();
        if(commonAgentName != null && !commonAgentName.isEmpty()) model.changeCommonAgentName(commonAgentName);
        if(customInstruction != null && !customInstruction.isEmpty()) model.changeCustomInstruction(customInstruction);
        if(replyStyle != null) model.changeReplyStyle(ReplyStyle.valueOf(replyStyle));
        if(title != null && !title.isEmpty()) model.changeTitle(title);
        return model;
    }





    private PersonalizationVO toVO(Personalization model) {
        PersonalizationVO vo = new PersonalizationVO();
        BeanUtils.copyProperties(model, vo);
        return vo;
    }

    private Personalization toModel(PersonalizationCommand command) {
        String replyStyle = command.getReplyStyle();
        return Personalization.builder()
                .id(command.getId())
                .replyStyle(replyStyle == null ? null :ReplyStyle.valueOf(replyStyle))
                .title(command.getTitle())
                .commonAgentName(command.getCommonAgentName())
                .customInstruction(command.getCustomInstruction())
                .build();
    }
}
