package com.summit.dp.personalization.application.service;


import com.summit.ddd.application.vo.Result;
import com.summit.dp.personalization.application.command.PersonalizationCommand;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.application.vo.ReplyStyleVO;

import java.util.List;

/**
 * Personalization 应用层服务接口（生成骨架）
 */
public interface PersonalizationService {
    Result<PersonalizationVO> current();
    Result<PersonalizationVO> findById(Long id);

    Result<Void> update(PersonalizationCommand command);


    Result<List<ReplyStyleVO>> listReplyStyles();

}
