package com.summit.dp.shared.settings;

import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * {@link SettingsProvider} 的默认实现：读取 {@code user_configs} 单例行
 * （主键 = {@link LocalInstance#SETTINGS_ROW_ID}）并投影为 {@link SettingsView}。
 *
 * <p>无设置行时返回与 {@link UserConfig#defaultConfig()} 同源的默认视图，
 * 保证全新环境「启动即可用」，而不是把缺省判断摊给每个使用方。</p>
 */
@Component
@RequiredArgsConstructor
public class DefaultSettingsProvider implements SettingsProvider {

    private final UserConfigRepository userConfigRepository;

    @Override
    public Optional<SettingsView> current() {
        return Optional.of(userConfigRepository.findSingleton()
                .map(DefaultSettingsProvider::toView)
                .orElseGet(DefaultSettingsProvider::defaultView));
    }

    /** 领域模型 → 只读投影；档位枚举做跨包同名义转换。 */
    static SettingsView toView(UserConfig config) {
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
                effort == null ? null : effort.getValue());
    }

    /** 与 {@link UserConfig#defaultConfig()} 同源的缺省值；仅在设置行不存在时使用。 */
    static SettingsView defaultView() {
        return new SettingsView(
                WorkspaceType.SAND_BOX,
                AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.PRE_EXEC_CONFIRM,
                UserConfig.DEFAULT_PLAN_MAX_REMINDERS,
                null,
                null,
                UserConfig.DEFAULT_MAX_TOKENS,
                ReasoningEffort.LOW.getValue());
    }
}
