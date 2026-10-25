package com.summit.dp.execution.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.execution.domain.model.RuntimeConfigRevision;
import com.summit.dp.execution.domain.repository.RuntimeConfigRevisionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.RuntimeConfigRevisionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.RuntimeConfigRevisionPO;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.Optional;

@Repository
@RequiredArgsConstructor
public class RuntimeConfigRevisionRepositoryImpl
        extends AbstractRepository<RuntimeConfigRevision, RuntimeConfigRevisionPO, Long>
        implements RuntimeConfigRevisionRepository {
    private final RuntimeConfigRevisionMapper revisionMapper;

    @Override
    public Optional<RuntimeConfigRevision> findRevision(String kind, long configId, int revision) {
        return Optional.ofNullable(revisionMapper.selectOne(Wrappers.<RuntimeConfigRevisionPO>lambdaQuery()
                .eq(RuntimeConfigRevisionPO::getKind, kind).eq(RuntimeConfigRevisionPO::getConfigId, configId)
                .eq(RuntimeConfigRevisionPO::getRevision, revision))).map(this::toModel);
    }

    @Override
    public Optional<RuntimeConfigRevision> findMatching(String kind, long configId, String fingerprint) {
        return Optional.ofNullable(revisionMapper.selectOne(Wrappers.<RuntimeConfigRevisionPO>lambdaQuery()
                .eq(RuntimeConfigRevisionPO::getKind, kind).eq(RuntimeConfigRevisionPO::getConfigId, configId)
                .eq(RuntimeConfigRevisionPO::getFingerprint, fingerprint))).map(this::toModel);
    }

    @Override
    public int latestRevision(String kind, long configId) {
        RuntimeConfigRevisionPO latest = revisionMapper.selectOne(Wrappers.<RuntimeConfigRevisionPO>lambdaQuery()
                .select(RuntimeConfigRevisionPO::getRevision)
                .eq(RuntimeConfigRevisionPO::getKind, kind).eq(RuntimeConfigRevisionPO::getConfigId, configId)
                .orderByDesc(RuntimeConfigRevisionPO::getRevision).last("LIMIT 1"));
        return latest == null ? 0 : latest.getRevision();
    }

    @Override
    public void updateById(RuntimeConfigRevision entity) {
        throw new ClientException("运行配置历史版本不能修改");
    }

    @Override
    public void update(Collection<RuntimeConfigRevision> entities) {
        throw new ClientException("运行配置历史版本不能修改");
    }

    @Override
    protected BaseMapper<RuntimeConfigRevisionPO> mapper() { return revisionMapper; }

    @Override
    protected RuntimeConfigRevisionPO toPO(RuntimeConfigRevision model) {
        RuntimeConfigRevisionPO row = new RuntimeConfigRevisionPO();
        BeanUtils.copyProperties(model, row);
        return row;
    }

    @Override
    protected RuntimeConfigRevision toModel(RuntimeConfigRevisionPO row) {
        return RuntimeConfigRevision.builder().id(row.getId()).kind(row.getKind()).configId(row.getConfigId())
                .revision(row.getRevision()).fingerprint(row.getFingerprint()).payload(row.getPayload())
                .createdAt(row.getCreatedAt()).build();
    }
}
