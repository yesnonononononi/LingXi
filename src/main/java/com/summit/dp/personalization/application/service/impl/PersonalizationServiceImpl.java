package com.summit.dp.personalization.application.service.impl;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.personalization.application.command.PersonalizationCommand;
import com.summit.dp.personalization.application.convert.PersonalizationConvert;
import com.summit.dp.personalization.application.service.PersonalizationService;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.application.vo.ReplyStyleVO;
import com.summit.dp.personalization.domain.model.Personalization;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Arrays;
import java.util.List;

/** 默认配置由后端创建，首次打开与后续编辑始终使用同一条真实记录。 */
@Service
@RequiredArgsConstructor
public class PersonalizationServiceImpl implements PersonalizationService {
    private final PersonalizationRepository repository;

    @Override
    @Transactional
    public Result<PersonalizationVO> current() {
        // 事务保留文件锁，防止两个首次读取同时插入默认配置。
        Personalization model = repository.findById(LocalInstance.SETTINGS_ROW_ID).orElse(null);
        if (model == null) {
            model = Personalization.builder().id(LocalInstance.SETTINGS_ROW_ID)
                    .replyStyle(ReplyStyle.DEFAULT).title("").commonAgentName("").customInstruction("").build();
            repository.save(model);
        }
        return Result.success(PersonalizationConvert.toVO(model));
    }

    @Override
    public Result<PersonalizationVO> findById(Long id) {
        throwIf(id == null, "个性化配置 ID 不能为空");
        Personalization model = repository.findById(id).orElseThrow(ClientException::new);
        return Result.success(PersonalizationConvert.toVO(model));
    }

    @Override
    @Transactional
    public Result<Void> update(PersonalizationCommand command) {
        throwIf(command == null, "个性化配置不能为空");
        throwIf(command.getId() == null, "个性化配置 ID 不能为空");
        ReplyStyle style = null;
        if (command.getReplyStyle() != null) {
            style = Arrays.stream(ReplyStyle.values())
                    .filter(candidate -> candidate.name().equals(command.getReplyStyle())).findFirst().orElse(null);
            throwIf(style == null, "回复风格不在支持列表中");
        }
        Personalization model = repository.findById(command.getId()).orElseThrow(ClientException::new);
        if (command.getCommonAgentName() != null) model.changeCommonAgentName(command.getCommonAgentName());
        if (command.getCustomInstruction() != null) model.changeCustomInstruction(command.getCustomInstruction());
        if (command.getReplyStyle() != null) model.changeReplyStyle(style);
        if (command.getTitle() != null) model.changeTitle(command.getTitle());
        repository.updateById(model);
        return Result.success();
    }

    @Override
    public Result<List<ReplyStyleVO>> listReplyStyles() {
        return Result.success(Arrays.stream(ReplyStyle.values())
                .map(style -> new ReplyStyleVO(style.name(), style.getDescription())).toList());
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
