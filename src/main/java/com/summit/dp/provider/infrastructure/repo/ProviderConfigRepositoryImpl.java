package com.summit.dp.provider.infrastructure.repo;

import com.summit.dp.provider.domain.model.ProviderConfig;
import com.summit.dp.provider.domain.repo.ProviderConfigRepository;
import com.summit.dp.provider.infrastructure.persistence.mapper.ProviderConfigMapper;
import com.summit.dp.provider.infrastructure.persistence.po.ProviderConfigPO;
import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * 提供商配置仓储：首次从 H2 导入后以 providers.json 为准。
 *
 * <p>与模型配置同构（{@link AbstractJsonRepository}）：JSON 是运行期真源，
 * 表只保证建库即有、并承接历史数据。</p>
 */
@Repository
public class ProviderConfigRepositoryImpl
        extends AbstractJsonRepository<ProviderConfig, ProviderConfigPO>
        implements ProviderConfigRepository {

    private static final Comparator<ProviderConfigPO> DISPLAY_ORDER =
            Comparator.comparingInt((ProviderConfigPO po) -> po.getSortOrder() == null ? 0 : po.getSortOrder())
                    .thenComparing(ProviderConfigPO::getName, Comparator.nullsLast(String::compareTo));

    public ProviderConfigRepositoryImpl(
            ProviderConfigMapper mapper,
            @Value("${lingxi.config.provider.path:${user.home}/.lingxi/config/providers.json}") String path) {
        super(Path.of(path), ProviderConfigPO.class, () -> mapper.selectList(null));
    }

    @Override
    protected Long resolveId(ProviderConfigPO po) {
        return po.getId();
    }

    @Override
    protected ProviderConfigPO prepareInsert(ProviderConfigPO po, long id) {
        Instant now = Instant.now();
        po.setId(id);
        if (po.getCreateTime() == null) po.setCreateTime(now);
        po.setUpdateTime(now);
        return po;
    }

    @Override
    protected ProviderConfigPO prepareUpdate(ProviderConfigPO previous, ProviderConfigPO replacement) {
        replacement.setCreateTime(previous.getCreateTime());
        replacement.setUpdateTime(Instant.now());
        return replacement;
    }

    @Override
    protected ProviderConfigPO toPO(ProviderConfig model) {
        return ProviderConfigPO.builder()
                .id(model.getId())
                .name(model.getName())
                .icon(model.getIcon())
                .baseUrl(model.getBaseUrl())
                .apiKey(model.getApiKey())
                .sortOrder(model.getSortOrder())
                .build();
    }

    @Override
    protected ProviderConfig toModel(ProviderConfigPO po) {
        return new ProviderConfig(po.getId(), po.getName(), po.getIcon(),
                po.getBaseUrl(), po.getApiKey(), po.getSortOrder());
    }

    @Override
    public Long saveAndReturnId(ProviderConfig config) {
        return save(config, ProviderConfigPO::getId).longValue();
    }

    @Override
    public List<ProviderConfig> findAll() {
        return store.access(false, records -> records.stream()
                .sorted(DISPLAY_ORDER).map(this::toModel).toList());
    }

    @Override
    public boolean existsByName(String name, Long excludeId) {
        if (name == null || name.isBlank()) return false;
        String target = name.trim();
        return store.access(false, records -> records.stream()
                .filter(po -> excludeId == null || !Objects.equals(po.getId(), excludeId))
                .map(ProviderConfigPO::getName)
                .filter(Objects::nonNull)
                .anyMatch(existing -> existing.trim().equalsIgnoreCase(target)));
    }
}
