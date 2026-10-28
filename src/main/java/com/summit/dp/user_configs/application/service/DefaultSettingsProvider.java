package com.summit.dp.user_configs.application.service;

import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * {@link SettingsProvider} 的默认实现：读取 {@code user_configs} 单例行
 * （主键 = {@link LocalInstance#SETTINGS_ROW_ID}）并投影为 {@link SettingsView}。
 *
 * <p>无设置行时返回与 {@link UserConfig#defaultConfig()} 同源的默认视图，
 * 保证全新环境「启动即可用」，而不是把缺省判断摊给每个使用方。</p>
 *
 * <p>{@code skillDir}/{@code teamSize} 是「yaml 只作缺省、设置行才是真源」的两项，
 * 回落判断统一收在这里 —— 否则每个使用方各写一遍，改一处必漏一处。</p>
 */
@Component
public class DefaultSettingsProvider implements SettingsProvider {

    private final UserConfigRepository userConfigRepository;

    /** Skill 根目录的 yaml 缺省；置空即关闭该能力，故保留原始串、投影时再转成 null。 */
    private final String defaultSkillDir;

    /** 团队规模上限的 yaml 缺省。 */
    private final int defaultTeamSize;

    public DefaultSettingsProvider(UserConfigRepository userConfigRepository,
                                   @Value("${lingxi.skill.dir:}") String defaultSkillDir,
                                   @Value("${lingxi.team.max-member-size:10}") int defaultTeamSize) {
        this.userConfigRepository = userConfigRepository;
        this.defaultSkillDir = defaultSkillDir;
        this.defaultTeamSize = defaultTeamSize;
    }

    @Override
    public Optional<SettingsView> current() {
        return Optional.of(userConfigRepository.findSingleton()
                .map(this::toView)
                .orElseGet(this::defaultView));
    }

    /** 领域模型 → 只读投影；档位枚举做跨包同名义转换，未配置的两项回落到 yaml 缺省。 */
    SettingsView toView(UserConfig config) {
        if (config == null) {
            return defaultView();
        }
        UserConfig.WorkSpaceConfig workSpaceConfig = config.getWorkSpaceConfig();
        WorkspaceType workspaceType = workSpaceConfig == null ? null : workSpaceConfig.type();
        AgentAccessMode accessMode = config.getAccessMode() == null
                ? null : AgentAccessMode.valueOf(config.getAccessMode().name());
        CommandApprovalPolicy policy = config.getCommandApprovalPolicy() == null
                ? null : CommandApprovalPolicy.valueOf(config.getCommandApprovalPolicy().name());
        ReasoningEffort effort = config.getReasoningEffort();
        return new SettingsView(
                workspaceType,
                accessMode,
                policy,
                config.getPlanMaxReminders(),
                config.getModelId(),
                config.getAgentId(),
                config.getMaxTokens(),
                effort == null ? null : effort.getValue(),
                effectiveSkillDir(config.getSkillDir()),
                config.getTeamSize() == null ? defaultTeamSize : config.getTeamSize(),
                config.getCompactModelId());
    }

    /** 与 {@link UserConfig#defaultConfig()} 同源的缺省值；仅在设置行不存在时使用。 */
    SettingsView defaultView() {
        return new SettingsView(
                WorkspaceType.SAND_BOX,
                AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.PRE_EXEC_CONFIRM,
                UserConfig.DEFAULT_PLAN_MAX_REMINDERS,
                null,
                null,
                UserConfig.DEFAULT_MAX_TOKENS,
                ReasoningEffort.LOW.getValue(),
                effectiveSkillDir(null),
                defaultTeamSize,
                null);
    }

    /** 设置行未指定时用 yaml 缺省；缺省为空串即「不提供 Skill」，投影成 null 交给使用方判断。 */
    private String effectiveSkillDir(String configured) {
        String effective = configured == null ? defaultSkillDir : configured;
        return effective == null || effective.isBlank() ? null : effective.trim();
    }
}
