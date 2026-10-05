package com.summit.dp.user_configs.infrastructure.repository;

import com.fasterxml.jackson.core.type.TypeReference;
import com.summit.ddd.infrastructure.repository.yaml.AbstractYamlRepository;
import com.summit.ddd.infrastructure.repository.yaml.YamlListStore;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.utils.YamlSerializer;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.persistence.mapper.UserConfigMapper;
import com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** UserConfig 仓储实现 */
@Repository
public class UserConfigRepositoryImpl extends AbstractYamlRepository<UserConfig, UserConfigPO>
        implements UserConfigRepository {

    public UserConfigRepositoryImpl(UserConfigMapper mapper, YamlSerializer serializer,
                                    @Value("${lingxi.config.user-configs.path:${user.home}/.lingxi/config/user-configs.yaml}") String path) {
        super(new YamlListStore<>(Path.of(path), serializer.listCodec(new TypeReference<List<UserConfigPO>>() {}),
                () -> mapper.selectList(null)));
    }

    @Override
    protected Long resolveId(UserConfigPO po) { return po.getId(); }

    @Override
    protected UserConfigPO prepareInsert(UserConfigPO po, long id) {
        if (id != LocalInstance.SETTINGS_ROW_ID) throw new IllegalArgumentException("用户配置 ID 必须为 1");
        po.setId(id);
        if (po.getCreateTime() == null) po.setCreateTime(Instant.now());
        po.setUpdateTime(Instant.now());
        return po;
    }

    @Override
    protected UserConfigPO prepareUpdate(UserConfigPO previous, UserConfigPO replacement) {
        replacement.setCreateTime(previous.getCreateTime());
        replacement.setUpdateTime(Instant.now());
        return replacement;
    }

    @Override
    protected UserConfig toModel(UserConfigPO po) {
        if (po == null) {
            return null;
        }
        String renderTheme = po.getRenderTheme();

        return UserConfig.builder()
                .id(po.getId())
                .status(po.getStatus())
                .commandApprovalPolicy(UserConfig.CommandPolicy.fromString(po.getCommandApprovalPolicy()))
                .accessMode(UserConfig.AccessMode.fromString(po.getAccessMode()))
                .planMaxReminders(po.getPlanMaxReminders())
                .agentId(po.getAgentId())
                .modelId(po.getModelId())
                .maxTokens(po.getMaxTokens())
                .reasoningEffort(ReasoningEffort.fromValue(po.getReasoningEffort()))
                .workSpaceConfig(new UserConfig.WorkSpaceConfig(WorkspaceType.fromCode(po.getWorkspaceType())))
                .renderTheme(renderTheme == null ? null :UserConfig.RenderTheme.valueOf(renderTheme))
                .createAt(po.getCreateTime())
                .updateAt(po.getUpdateTime())
                .build();
    }

    @Override
    protected UserConfigPO toPO(UserConfig model) {
        if (model == null) {
            return null;
        }

        UserConfig.WorkSpaceConfig workSpaceConfig = model.getWorkSpaceConfig();
        WorkspaceType type = workSpaceConfig == null ? null : workSpaceConfig.type();

        return UserConfigPO.builder()
                .id(model.getId())
                .status(model.getStatus())
                .commandApprovalPolicy(Objects.toString(model.getCommandApprovalPolicy(), null))
                .accessMode(Objects.toString(model.getAccessMode(), null))
                .planMaxReminders(model.getPlanMaxReminders())
                .agentId(model.getAgentId())
                .modelId(model.getModelId())
                .maxTokens(model.getMaxTokens())
                .reasoningEffort(model.getReasoningEffort() == null ? null : model.getReasoningEffort().getValue())
                .workspaceType(type == null ? null :type.code())
                .renderTheme(model.getRenderTheme() == null ? null : model.getRenderTheme().name())
                .createTime(model.getCreateAt())
                .updateTime(model.getUpdateAt())
                .build();
    }

    @Override
    public Optional<UserConfig> findSingleton() {
        return findById(LocalInstance.SETTINGS_ROW_ID);
    }
}
