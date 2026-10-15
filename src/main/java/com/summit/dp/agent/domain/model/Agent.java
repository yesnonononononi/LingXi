package com.summit.dp.agent.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/** Agent 领域模型 */
@Builder
@Getter
public class Agent {

    /** 名称最大长度 */
    public static final int NAME_MAX_LENGTH = 100;
    /** 描述最大长度 */
    public static final int DESCRIPTION_MAX_LENGTH = 500;
    /** 提示词最大长度 */
    public static final int PROMPT_MAX_LENGTH = 20_000;
    /** 头像最大长度（Emoji 或图片 URL） */
    public static final int AVATAR_MAX_LENGTH = 255;
    /** 单个 Agent 允许配置的工具数量上限 */
    public static final int TOOL_MAX_SIZE = 30;
    /** 状态：正常 */
    public static final int STATUS_ENABLED = 1;

    private final Long id;
    private final Long uid;
    private String name;
    private Long modelId;
    private List<String> toolList;
    private String prompt;
    private String description;
    /** 头像（Emoji 或图片 URL），可空 */
    private String avatar;
    /** 状态: 1正常 0禁用 */
    private Integer status;
    private Instant updateAt;
        private Instant createAt;

    /** 名称必填；空白或超长一律拒绝，不静默丢弃（静默丢弃会让调用方误判为已生效）。 */
    public void changeName(String name) {
        if (name == null || name.isBlank()) throw new ClientException("Agent名称不能为空");
        if (name.trim().length() > NAME_MAX_LENGTH)
            throw new ClientException("Agent名称长度不能超过" + NAME_MAX_LENGTH);
        this.name = name;
        update();
    }

    public void changeModelId(Long modelId) {
        if (modelId == null) throw new ClientException("必须指定模型");
        this.modelId = modelId;
        update();
    }

    public void changeStatus(int status) {
        this.status = status;
        update();
    }

    /** 提示词必填。 */
    public void changePrompt(String prompt) {
        if (prompt == null || prompt.isBlank()) throw new ClientException("提示词不能为空");
        if (prompt.trim().length() > PROMPT_MAX_LENGTH)
            throw new ClientException("提示词长度不能超过" + PROMPT_MAX_LENGTH);
        this.prompt = prompt;
        update();
    }

    /** 追加单个工具；空名、超量或重复一律拒绝。 */
    public void addTool(String toolName) {
        if (toolName == null || toolName.isBlank()) throw new ClientException("工具名称不能为空");
        if (toolList == null) toolList = new ArrayList<>();
        if (toolList.size() >= TOOL_MAX_SIZE)
            throw new ClientException("工具数量不能超过" + TOOL_MAX_SIZE);
        String name = toolName.trim();
        if (toolList.contains(name)) throw new ClientException("工具不允许重复: " + name);
        toolList.add(name);
        update();
    }

    /**
     * 整体替换工具清单；null 视为非法调用，超量或含空白项一律拒绝。
     *
     * <p>重复项与「是否已注册」属入口校验（{@code AgentValidator}）的职责，本方法只守住结构不变量。</p>
     */
    public void changeTools(Collection<String> tools) {
        if (tools == null) throw new ClientException("工具列表不能为空");
        if (tools.size() > TOOL_MAX_SIZE)
            throw new ClientException("工具数量不能超过" + TOOL_MAX_SIZE);
        for (String tool : tools) {
            if (tool == null || tool.isBlank()) throw new ClientException("工具名称不能为空");
        }
        this.toolList = new ArrayList<>(tools);
        update();
    }

    public void changeDescription(String description) {
        if (description == null) throw new ClientException("Agent描述不能为空");
        if (description.length() > DESCRIPTION_MAX_LENGTH)
            throw new ClientException("Agent描述长度不能超过" + DESCRIPTION_MAX_LENGTH);
        this.description = description;
        update();
    }

    /** 头像允许清空（传空串即清除）；超长拒绝，与本类其它变更方法口径一致。 */
    public void changeAvatar(String avatar) {
        if (avatar == null) throw new ClientException("Agent头像不能为空");
        if (avatar.length() > AVATAR_MAX_LENGTH)
            throw new ClientException("Agent头像长度不能超过" + AVATAR_MAX_LENGTH);
        this.avatar = avatar.isEmpty() ? null : avatar;
        update();
    }

    public void update(){
        this.updateAt = Instant.now();
    }

    /** 是否为可用状态（历史数据的 status 可能为空，视为可用） */
    public boolean enabled() {
        return status == null || status == STATUS_ENABLED;
    }
}
