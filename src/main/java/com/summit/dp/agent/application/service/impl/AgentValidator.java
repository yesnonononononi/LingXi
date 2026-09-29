package com.summit.dp.agent.application.service.impl;

import com.summit.dp.agent.application.command.AgentCommand;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.domain.ModelNoFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Agent 新增/更新的业务校验。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class AgentValidator {

    private final ModelService modelService;
    private final ToolCatalog toolCatalog;

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForCreate(AgentCommand command) {
        if (command == null) return "新增参数不能为空";

        String nameError = checkName(command.getName());
        if (nameError != null) return nameError;

        String descriptionError = checkDescription(command.getDescription());
        if (descriptionError != null) return descriptionError;

        String promptError = checkPrompt(command.getPrompt());
        if (promptError != null) return promptError;

        String modelError = checkModel(command.getModelId());
        if (modelError != null) return modelError;

        return checkTools(command.getToolList());
    }

    /** 更新只校验本次传入的字段，未传入（null）的字段视为不修改。 */
    public String validateForUpdate(AgentCommand command) {
        if (command == null) return "更新参数不能为空";
        if (command.getId() == null) return "id不能为空";

        if (command.getName() != null) {
            String nameError = checkName(command.getName());
            if (nameError != null) return nameError;
        }
        if (command.getDescription() != null) {
            String descriptionError = checkDescription(command.getDescription());
            if (descriptionError != null) return descriptionError;
        }
        if (command.getPrompt() != null) {
            String promptError = checkPrompt(command.getPrompt());
            if (promptError != null) return promptError;
        }
        if (command.getModelId() != null) {
            String modelError = checkModel(command.getModelId());
            if (modelError != null) return modelError;
        }
        if (command.getToolList() != null) {
            String toolsError = checkTools(command.getToolList());
            if (toolsError != null) return toolsError;
        }
        return null;
    }

    private String checkName(String name) {
        if (name == null || name.isBlank()) return "Agent名称不能为空";
        if (name.trim().length() > Agent.NAME_MAX_LENGTH)
            return "Agent名称长度不能超过" + Agent.NAME_MAX_LENGTH;
        return null;
    }

    private String checkDescription(String description) {
        if (description != null && description.length() > Agent.DESCRIPTION_MAX_LENGTH)
            return "Agent描述长度不能超过" + Agent.DESCRIPTION_MAX_LENGTH;
        return null;
    }

    private String checkPrompt(String prompt) {
        if (prompt == null || prompt.isBlank()) return "提示词不能为空";
        if (prompt.trim().length() > Agent.PROMPT_MAX_LENGTH)
            return "提示词长度不能超过" + Agent.PROMPT_MAX_LENGTH;
        return null;
    }

    /** 模型必须存在 */
    private String checkModel(Long modelId) {
        if (modelId == null) return "必须指定模型";
        try {
            ModelConfigVO model = modelService.findById(modelId).getData();
            if (model == null) return "指定的模型不存在: " + modelId;
        } catch (ModelNoFoundException e) {
            return "指定的模型不存在: " + modelId;
        }
        return null;
    }

    /** 工具必须已注册，且不允许出现指挥者专属的委派工具 */
    private String checkTools(List<String> toolList) {
        if (toolList == null || toolList.isEmpty()) return null;
        if (toolList.size() > Agent.TOOL_MAX_SIZE)
            return "工具数量不能超过" + Agent.TOOL_MAX_SIZE;

        Set<String> registered = toolCatalog.names();
        Set<String> seen = new HashSet<>();
        for (String tool : toolList) {
            if (tool == null || tool.isBlank()) return "工具名称不能为空";
            String name = tool.trim();
            if (!seen.add(name)) return "工具不允许重复: " + name;
            if (toolCatalog.isDelegationTool(name))
                return "工具 " + name + " 是指挥者专属的委派工具，不允许配置在 Agent 上，团队协作开始时会自动授予指挥者";
            if (!registered.contains(name)) return "工具不存在: " + name;
        }
        return null;
    }
}
