package com.summit.dp.personalization.infrastructure.repository;

import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;
import com.summit.dp.personalization.domain.model.Personalization;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.personalization.infrastructure.persistence.po.PersonalizationPO;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Instant;

/** 个性化设置独立落盘，避免与模型和通用配置互相覆盖。 */
@Repository
public class PersonalizationRepositoryImpl extends AbstractJsonRepository<Personalization, PersonalizationPO>
        implements PersonalizationRepository {

    public PersonalizationRepositoryImpl(@Value("${lingxi.config.personalization.path:${user.home}/.lingxi/config/personalization.json}") String path) {
        super(Path.of(path), PersonalizationPO.class);
    }

    @Override
    protected Long resolveId(PersonalizationPO po) {
        return po.getId();
    }

    @Override
    protected PersonalizationPO prepareInsert(PersonalizationPO po, long id) {
        po.setId(id);
        if (po.getCreateAt() == null) po.setCreateAt(Instant.now());
        po.setUpdateAt(Instant.now());
        return po;
    }

    @Override
    protected PersonalizationPO prepareUpdate(PersonalizationPO previous, PersonalizationPO replacement) {
        replacement.setCreateAt(previous.getCreateAt());
        replacement.setUpdateAt(Instant.now());
        return replacement;
    }

    @Override
    protected Personalization toModel(PersonalizationPO po) {
         return Personalization.builder()
                 .id(po.getId())
                 .replyStyle(po.getReplyStyle() == null ? null : ReplyStyle.valueOf(po.getReplyStyle()))
                 .title(po.getTitle())
                 .commonAgentName(po.getCommonAgentName())
                 .customInstruction(po.getCustomInstruction())
                 .createAt(po.getCreateAt())
                 .updateAt(po.getUpdateAt())
                 .build();
    }

    @Override
    protected PersonalizationPO toPO(Personalization model) {
        return PersonalizationPO.builder()
                .id(model.getId())
                .replyStyle(model.getReplyStyle() == null ? null : model.getReplyStyle().name())
                .title(model.getTitle())
                .commonAgentName(model.getCommonAgentName())
                .customInstruction(model.getCustomInstruction())
                .createAt(model.getCreateAt())
                .updateAt(model.getUpdateAt())
                .build();
    }
}
