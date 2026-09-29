package com.summit.dp.team.domain.model;

import lombok.Builder;
import lombok.Data;
import lombok.Getter;

import java.time.Instant;
import java.util.List;

/** Team 领域模型 */
@Builder
@Getter
public class Team {

    /** 名称最大长度 */
    public static final int NAME_MAX_LENGTH = 100;
    /** 默认成员数量上限，可由 {@code lingxi.team.max-member-size} 覆盖 */
    public static final int MAX_MEMBER_SIZE = 10;

    public static final int MAX_DESCRIPTION_LENGTH = 500;

    private final Long id;
    private final Long uid;
    private String name;
    /** 指挥者 Agent ID */
    private Long commanderAgentId;
    /** 成员 Agent ID 列表（含指挥者） */
    private List<Long> agentIds;

    private final Instant createAt;

    private String description;

    private Instant updateAt;


    public void changeDescription(String description){
        if(description == null) throw new IllegalArgumentException("Description is null");
        if(description.length() > MAX_DESCRIPTION_LENGTH) throw new IllegalArgumentException("Description is too long");
        this.description = description;
        update();
    }

    public void changeName(String name){
        if(name == null || name.length() > NAME_MAX_LENGTH) throw new IllegalArgumentException("Invalid team name: " + name);
        this.name = name;
        update();
    }

    public void changeCommanderAgentId(Long commanderAgentId){
        if(commanderAgentId == null) throw new IllegalArgumentException("Commander agent id is null");
        this.commanderAgentId = commanderAgentId;
        update();
    }
    public void changeAgentIds(List<Long> agentIds){
        if(agentIds == null) throw new IllegalArgumentException("Agent ids is null");
        if(agentIds.size() > MAX_MEMBER_SIZE) throw new IllegalArgumentException("Team member size exceeds the limit: " + MAX_MEMBER_SIZE);
        this.agentIds = agentIds;
        update();
    }


    public void addTeammate(Long agentId){
        if(agentId == null) throw new IllegalArgumentException("Agent id is null");
        if(this.agentIds.contains(agentId)) throw new IllegalArgumentException("Agent id already exists: " + agentId);
        if(this.agentIds.size() >= MAX_MEMBER_SIZE) throw new IllegalArgumentException("Team member size exceeds the limit: " + MAX_MEMBER_SIZE);
        this.agentIds.add(agentId);
        update();
    }

    public void removeTeammate(Long agentId){
        if(agentId == null) throw new IllegalArgumentException("Agent id is null");
        this.agentIds.remove(agentId);
        update();
    }



    private void update(){
        this.updateAt = Instant.now();
    }
}
