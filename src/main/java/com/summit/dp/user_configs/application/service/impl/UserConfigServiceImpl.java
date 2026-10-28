package com.summit.dp.user_configs.application.service.impl;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Objects;
import java.util.Optional;

/**
 * UserConfig 应用层服务实现。
 *
 * <p><b>单例行定位</b>：配置按 {@link LocalInstance#SETTINGS_ROW_ID}（主键=1）读写，
 * 不再按用户定位。首次读取无行时落一条默认行，保证「启动即可用」。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class UserConfigServiceImpl implements UserConfigService {
    private final UserConfigRepository repository;
    /**
     * 校验 modelId 存在性：模型业务在 model 模块，这里只借它的断言，不复制规则。
     */
    private final ModelService modelService;
    /** skillDir / teamSize 的生效值来源（已含 yaml 缺省），避免本类再写一遍回落判断。 */
    private final SettingsProvider settingsProvider;
    /** 改目录时负责把现有内容搬到新目录；搬成功才允许落库。 */
    private final SettingsDirectoryMigrator directoryMigrator;

    /**
     * 本进程实际打开的库目录：启动时绑定一次，且启动前已由 bootstrap 用设置行的值覆盖配置项，
     * 所以它天然是「本次运行真正生效的目录」—— 改设置后两者不等，就是「待重启」。
     */
    @Value("${lingxi.data.dir}")
    private String activeDataDir;

    @Override
    public Result<UserConfigVO> current() {
        UserConfig config = repository.findSingleton().orElse(null);
        if (config == null) {
            // 首次读取落默认行：defaultConfig 显式带主键 1（表列非自增且有
            // CHECK (id = 1)），不会出现「自增落行 ≠ 1、下次仍读不到」的循环。
            config = UserConfig.defaultConfig();
            repository.save(config);
        }
        return Result.success(toVO(config, settingsProvider.current().orElse(null)));
    }

    @Override
    public Result<Void> update(UserConfigCommand command) {
        if (command == null)
            throw new ClientException("配置更新参数不能为空");
        // 设置模型前先校验存在性：否则可以把 model_id 指向不存在的模型，
        // 后续聊天链路会拿着无效的模型配置发起调用。
        assertModelAccessible(command.modelId());
        // 专用压缩模型同样只能在「模型存在且凭据齐备」时才落库：
        // 否则每次压缩都在运行时抛错，而错误出现在一轮对话的中途，用户根本无从定位。
        assertCompactModelUsable(command.compactModelId(), command.compactModelIdPresent());
        // INSERT/UPDATE 按「行是否存在」判断，不能按 id 是否为 null 判断：
        // 默认配置自带主键 1，若按 id 判空会误走 UPDATE，在无行时静默影响 0 行。
        Optional<UserConfig> existing = repository.findSingleton();
        UserConfig newC = apply(command, existing.orElseGet(UserConfig::defaultConfig));
        if (existing.isPresent()) {
            repository.updateById(newC);
        } else {
            repository.save(newC);
        }
        return Result.success();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

    /**
     * 校验模型可访问性。
     *
     * <p>委托 {@code ModelService.findById} 触发 model 模块自己的存在性断言，
     * 而不是在这里重写一份判断 —— 规则只能有一个真源。</p>
     */
    private void assertModelAccessible(Long modelId) {
        if (modelId == null) {
            return;
        }
        modelService.findById(modelId);
    }

    /**
     * 校验专用压缩模型可用：存在（findById 自带断言）且凭据齐备。
     *
     * <p>不传该字段的请求不校验；显式传 {@code null} 是「取消专用压缩模型」，
     * 也不能因为「没有模型可查」而报错。</p>
     */
    private void assertCompactModelUsable(Long compactModelId, boolean present) {
        if (!present || compactModelId == null) {
            return;
        }
        ModelConfigVO compact = modelService.findById(compactModelId).getData();
        throwIf(compact == null || !compact.isCredentialConfigured(),
                "专用压缩模型缺少可用的 API 凭据，请先在模型页补全密钥");
    }


    private UserConfig apply(UserConfigCommand command, UserConfig model) {
        String accessMode = command.accessMode();
        if (accessMode != null)
            model.changeAccessMode(UserConfig.AccessMode.fromString(accessMode));

        String commandApprovalPolicy = command.commandApprovalPolicy();
        if (commandApprovalPolicy != null)
            model.changeCommandPolicy(UserConfig.CommandPolicy.fromString(commandApprovalPolicy));

        Integer planMaxReminders = command.planMaxReminders();
        if (planMaxReminders != null)
            model.changePlanMaxReminders(planMaxReminders);

        Long modelId = command.modelId();
        if (modelId != null) model.changeModel(modelId);

        // agentId 允许显式为 null（取消绑定），与 modelId 的「非 null 才改」规则相反：
        // 必须按 command 上的出现标记判断，光判值会把「解绑」当成「没传」。
        if (command.agentIdPresent()) model.changeAgent(command.agentId());

        // 压缩模型与 agentId 同构：显式 null = 回到「沿用对话模型」，不传 = 保持原值。
        if (command.compactModelIdPresent()) model.changeCompactModel(command.compactModelId());

        String workspaceType = command.workspaceType();
        if (workspaceType != null)
            model.changeWorkspace(new UserConfig.WorkSpaceConfig(WorkspaceType.fromCode(workspaceType)));

        Integer maxTokens = command.maxTokens();
        if (maxTokens != null)
            model.changeMaxTokens(maxTokens);

        String reasoningEffort = command.reasoningEffort();
        if (reasoningEffort != null)
            model.changeReasoningEffort(Objects.requireNonNull(ReasoningEffort.fromValue(reasoningEffort)));

        String renderTheme = command.renderTheme();
        if (renderTheme != null)
            model.changeRenderTheme(renderTheme);

        // 目录类字段的顺序不能反：先把现有内容搬到新目录（搬失败即抛错、配置保持原样），
        // 再记新位置。反过来的话，一旦搬迁失败，配置已经指向一个空目录，用户看到的是「数据没了」。
        String requestedDataDir = command.dataDir();
        if (requestedDataDir != null) {
            String targetDataDir = normalizeDirectory(requestedDataDir, "数据存储目录");
            directoryMigrator.migrateDataDir(effectiveDataDir(model), targetDataDir);
            model.changeDataDir(targetDataDir);
            log.info("数据存储目录已改为: dir={}", targetDataDir);
        }

        String requestedSkillDir = command.skillDir();
        if (requestedSkillDir != null) {
            String targetSkillDir = normalizeDirectory(requestedSkillDir, "技能目录");
            directoryMigrator.migrateSkillDir(effectiveSkillDir(), targetSkillDir);
            model.changeSkillDir(targetSkillDir);
            log.info("技能目录已改为: dir={}", targetSkillDir);
        }

        Integer teamSize = command.teamSize();
        if (teamSize != null) {
            throwIf(teamSize < UserConfig.MIN_TEAM_SIZE || teamSize > UserConfig.MAX_TEAM_SIZE,
                    "团队规模上限必须在 " + UserConfig.MIN_TEAM_SIZE + "~" + UserConfig.MAX_TEAM_SIZE + " 之间");
            model.changeTeamSize(teamSize);
        }

        return model;
    }

    /** 目录类入参的统一校验：说清哪里不对，别让它变成落库时的列宽截断。 */
    private String normalizeDirectory(String raw, String label) {
        String trimmed = raw == null ? null : raw.trim();
        throwIf(trimmed == null || trimmed.isEmpty(), label + "不能为空");
        throwIf(trimmed.length() > UserConfig.MAX_DIRECTORY_LENGTH,
                label + "长度不能超过 " + UserConfig.MAX_DIRECTORY_LENGTH);
        return trimmed;
    }

    /** 当前生效的数据目录：设置行写了就用它，没写就是本进程实际打开的目录。 */
    private String effectiveDataDir(UserConfig model) {
        return model.getDataDir() == null ? activeDataDir : model.getDataDir();
    }

    /** 当前生效的技能目录；未启用 Skill 时为 null，由搬迁方按「无内容可搬」处理。 */
    private String effectiveSkillDir() {
        return settingsProvider.current().map(SettingsView::skillDir).orElse(null);
    }

    private UserConfigVO toVO(UserConfig model, SettingsView settings) {
        UserConfig.WorkSpaceConfig workSpaceConfig = model.getWorkSpaceConfig();
        UserConfig.CommandPolicy commandApprovalPolicy = model.getCommandApprovalPolicy();
        UserConfig.AccessMode accessMode = model.getAccessMode();
        ReasoningEffort reasoningEffort = model.getReasoningEffort();
        String dataDir = effectiveDataDir(model);
        return UserConfigVO.builder()
                .id(model.getId())
                .modelId(model.getModelId())
                .agentId(model.getAgentId())
                .type(workSpaceConfig == null ? null : workSpaceConfig.type())
                .commandApprovalPolicy(commandApprovalPolicy == null ? null : commandApprovalPolicy.name())
                .accessMode(accessMode == null ? null : accessMode.name())
                .planMaxReminders(model.getPlanMaxReminders())
                .maxTokens(model.getMaxTokens())
                .reasoningEffort(reasoningEffort == null ? null : reasoningEffort.getValue())
                .renderTheme(model.getRenderTheme() == null ? null : model.getRenderTheme().toString())
                .dataDir(dataDir)
                .skillDir(settings == null ? null : settings.skillDir())
                .teamSize(settings == null ? null : settings.teamSize())
                .compactModelId(model.getCompactModelId())
                .dataDirRestartRequired(isDataDirRestartRequired(dataDir))
                .build();
    }

    /** 生效目录 ≠ 本进程打开的目录 ⇒ 库文件还在旧目录上写，必须重启才切得过去。 */
    private boolean isDataDirRestartRequired(String dataDir) {
        return !normalizePath(dataDir).equals(normalizePath(activeDataDir));
    }

    private Path normalizePath(String directory) {
        return Path.of(directory.trim()).toAbsolutePath().normalize();
    }


}
