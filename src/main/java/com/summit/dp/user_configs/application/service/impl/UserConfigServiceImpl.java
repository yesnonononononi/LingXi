package com.summit.dp.user_configs.application.service.impl;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

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

    /**
     * 数据存储目录：普通配置项（{@code lingxi.data.dir}），H2 库文件即落在该目录。
     * 它不再是库内字段，这里只负责把它原样回显给前端。
     */
    @Value("${lingxi.data.dir}")
    private String dataDir;

    @Override
    public Result<UserConfigVO> current() {
        UserConfig config = repository.findSingleton().orElse(null);
        if (config == null) {
            // 首次读取落默认行：defaultConfig 显式带主键 1（表列非自增且有
            // CHECK (id = 1)），不会出现「自增落行 ≠ 1、下次仍读不到」的循环。
            config = UserConfig.defaultConfig();
            repository.save(config);
        }
        return Result.success(toVO(config));
    }

    @Override
    public Result<Void> update(UserConfigCommand command) {
        if (command == null)
            throw new ClientException("command is null");
        // 设置模型前先校验存在性：否则可以把 model_id 指向不存在的模型，
        // 后续聊天链路会拿着无效的模型配置发起调用。
        assertModelAccessible(command.modelId());
        // INSERT/UPDATE 按「行是否存在」判断，不能按 id 是否为 null 判断：
        // 默认配置自带主键 1，若按 id 判空会误走 UPDATE，在无行时静默影响 0 行。
        Optional<UserConfig> existing = repository.findSingleton();
        UserConfig newC = update(command, existing.orElseGet(UserConfig::defaultConfig));
        if (existing.isPresent()) {
            repository.updateById(newC);
        } else {
            repository.save(newC);
        }
        return Result.success();
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


    private UserConfig update(UserConfigCommand userConfigCommand, UserConfig model) {
        String accessMode = userConfigCommand.accessMode();
        if (accessMode != null)
            model.changeAccessMode(UserConfig.AccessMode.fromString(accessMode));

        String commandApprovalPolicy = userConfigCommand.commandApprovalPolicy();
        if (commandApprovalPolicy != null)
            model.changeCommandPolicy(UserConfig.CommandPolicy.fromString(commandApprovalPolicy));

        Integer planMaxReminders = userConfigCommand.planMaxReminders();
        if (planMaxReminders != null)
            model.changePlanMaxReminders(planMaxReminders);

        Long modelId = userConfigCommand.modelId();
        if (modelId != null) model.changeModel(modelId);

        // agentId 允许显式为 null（取消绑定），与 modelId 的「非 null 才改」规则相反：
        // 必须按 command 上的出现标记判断，光判值会把「解绑」当成「没传」。
        if (userConfigCommand.agentIdPresent()) model.changeAgent(userConfigCommand.agentId());

        String workspaceType = userConfigCommand.workspaceType();
        if (workspaceType != null)
            model.changeWorkspace(new UserConfig.WorkSpaceConfig(WorkspaceType.fromCode(workspaceType)));

        Integer maxTokens = userConfigCommand.maxTokens();
        if (maxTokens != null)
            model.changeMaxTokens(maxTokens);

        String reasoningEffort = userConfigCommand.reasoningEffort();
        if (reasoningEffort != null)
            model.changeReasoningEffort(Objects.requireNonNull(ReasoningEffort.fromValue(reasoningEffort)));

        String renderTheme = userConfigCommand.renderTheme();
        if (renderTheme != null)
            model.changeRenderTheme(renderTheme);

        return model;
    }

    private UserConfigVO toVO(UserConfig model) {
        UserConfig.WorkSpaceConfig workSpaceConfig = model.getWorkSpaceConfig();
        UserConfig.CommandPolicy commandApprovalPolicy = model.getCommandApprovalPolicy();
        UserConfig.AccessMode accessMode = model.getAccessMode();
        ReasoningEffort reasoningEffort = model.getReasoningEffort();
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
                .dataStorage(dataDir)
                .build();
    }


}
