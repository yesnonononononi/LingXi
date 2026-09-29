package com.summit.dp.user_configs.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.persistence.mapper.UserConfigMapper;
import com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.Objects;
import java.util.Optional;

/** UserConfig 仓储实现 */
@Repository
public class UserConfigRepositoryImpl extends AbstractRepository<UserConfig, UserConfigPO, Long>
        implements UserConfigRepository {

    private final UserConfigMapper mapper;

    public UserConfigRepositoryImpl(UserConfigMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<UserConfigPO> mapper() {
        return this.mapper;
    }

    @Override
    protected UserConfig toModel(UserConfigPO po) {
        if (po == null) {
            return null;
        }

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
                .modelId(model.getModelId())
                .maxTokens(model.getMaxTokens())
                .reasoningEffort(model.getReasoningEffort() == null ? null : model.getReasoningEffort().getValue())
                .workspaceType(type == null ? null :type.code())
                .createTime(model.getCreateAt())
                .updateTime(model.getUpdateAt())
                .build();
    }

    @Override
    public Optional<UserConfig> findSingleton() {
        return findById(LocalInstance.SETTINGS_ROW_ID);
    }
}
