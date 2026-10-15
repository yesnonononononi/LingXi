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
    /** 成员数量上限的缺省值；实际上限由设置页的 {@code teamSize} 决定，这里只作兜底 */
    public static final int MAX_MEMBER_SIZE = 10;

    public static final int MAX_DESCRIPTION_LENGTH = 1000;

    /** 头像最大长度（Emoji 或图片 URL） */
    public static final int MAX_AVATAR_LENGTH = 255;

    private final Long id;
    private final Long uid;
    private String name;
    /** 指挥者 Agent ID */
    private Long commanderAgentId;
    /** 成员 Agent ID 列表（含指挥者） */
    private List<Long> agentIds;

    private final Instant createAt;

    private String description;

    /** 头像（Emoji 或图片 URL），可空 */
    private String avatar;

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

    /** 头像允许清空（传空串即清除），口径与 {@link #changeDescription} 一致（违规抛异常）。 */
    public void changeAvatar(String avatar){
        if(avatar == null) throw new IllegalArgumentException("Avatar is null");
        if(avatar.length() > MAX_AVATAR_LENGTH) throw new IllegalArgumentException("Avatar is too long");
        this.avatar = avatar.isEmpty() ? null : avatar;
        update();
    }

    public void changeCommanderAgentId(Long commanderAgentId){
        if(commanderAgentId == null) throw new IllegalArgumentException("Commander agent id is null");
        this.commanderAgentId = commanderAgentId;
        update();
    }
    /** 上限由调用方传入（设置行的 teamSize），不能在域内写死 —— 写死会让「设置改大了」在更新路径上被拒。 */
    public void changeAgentIds(List<Long> agentIds, int maxMemberSize){
        if(agentIds == null) throw new IllegalArgumentException("Agent ids is null");
        if(agentIds.size() > maxMemberSize) throw new IllegalArgumentException("Team member size exceeds the limit: " + maxMemberSize);
        this.agentIds = agentIds;
        update();
    }


    public void addTeammate(Long agentId, int maxMemberSize){
        if(agentId == null) throw new IllegalArgumentException("Agent id is null");
        if(this.agentIds.contains(agentId)) throw new IllegalArgumentException("Agent id already exists: " + agentId);
        if(this.agentIds.size() >= maxMemberSize) throw new IllegalArgumentException("Team member size exceeds the limit: " + maxMemberSize);
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
