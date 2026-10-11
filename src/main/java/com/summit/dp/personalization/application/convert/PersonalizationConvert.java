package com.summit.dp.personalization.application.convert;

import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.model.Personalization;

public final class PersonalizationConvert {
    private PersonalizationConvert() {}

    public static PersonalizationVO toVO(Personalization model) {
        PersonalizationVO vo = new PersonalizationVO();
        vo.setId(model.getId());
        vo.setReplyStyle(model.getReplyStyle() == null ? null : model.getReplyStyle().name());
        vo.setTitle(model.getTitle());
        vo.setCommonAgentName(model.getCommonAgentName());
        vo.setCustomInstruction(model.getCustomInstruction());
        return vo;
    }
}
