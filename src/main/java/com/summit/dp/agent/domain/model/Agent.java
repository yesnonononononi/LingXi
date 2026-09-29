package com.summit.dp.agent.domain.model;

import lombok.Builder;
import lombok.Data;
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
    /** 单个 Agent 允许配置的工具数量上限 */
    public static final int TOOL_MAX_SIZE = 30;
    /** 状态：正常 */
    public static final int STATUS_ENABLED = 1;

    private final Long id;
    private final Long uid;
    private String name;
    private  Long modelId;
    private List<String> toolList;
    private String prompt;
    private String description;
    /** 状态: 1正常 0禁用 */
    private Integer status;
    private Instant updateAt;
    private Instant createAt;

    public void changName(String name){
        if(name == null || name.length() > NAME_MAX_LENGTH || name.isEmpty())return;
        this.name = name;
        update();
    }
    public void changeModelId(Long modelId){
        this.modelId = modelId;
        update();
    }
    public void changeStatus(int status){
        this.status = status;
        update();
    }

    public void changePrompt(String prompt){
        if(prompt == null || prompt.length() > PROMPT_MAX_LENGTH) return;
        this.prompt = prompt;
        update();
    }

    public void addTool(String toolName){
        if(toolName == null || toolName.isEmpty()) return;
        if(toolList == null) toolList = new ArrayList<>();
        if(toolList.size() >= TOOL_MAX_SIZE) return;
        if(toolList.contains(toolName)) return;
        toolList.add(toolName);
        update();
    }

    public void changeTools(Collection<String> tools){
        if(tools == null) return;
        this.toolList = new ArrayList<>(tools);
        update();
    }
    public void changeDescription(String description){
        if(description == null || description.length() > DESCRIPTION_MAX_LENGTH) return;
        this.description = description;
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
