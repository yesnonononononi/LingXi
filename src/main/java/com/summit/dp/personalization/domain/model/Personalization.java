package com.summit.dp.personalization.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * Personalization 领域模型（生成骨架）
 * <p>业务字段与领域方法按需在生成后补充，
 * 建议创建/状态变更收敛为静态工厂与领域方法。</p>
 */
@Data
@Builder
public class Personalization {
    private final Long id;
    private  ReplyStyle replyStyle;
    // agent对用户的称呼
    private String title;
    // agent的通用名字
    private String commonAgentName;
    private String customInstruction;
    @Builder.Default
    private final Instant createAt = Instant.now();
    private Instant updateAt;


    public void changeTitle(String title) {
        throwIf(title == null, "称呼不能为 null，清除称呼请传空字符串");
        this.title = title;
        this.updateAt = Instant.now();
    }

    public void changeCommonAgentName(String commonAgentName) {
        throwIf(commonAgentName == null, "助手名字不能为 null，清除名字请传空字符串");
        this.commonAgentName = commonAgentName;
        this.updateAt = Instant.now();
    }

    public void changeCustomInstruction(String customInstruction) {
        throwIf(customInstruction == null, "自定义指令不能为 null，清除指令请传空字符串");
        this.customInstruction = customInstruction;
        this.updateAt = Instant.now();
    }

    public void changeReplyStyle(ReplyStyle replyStyle) {
        throwIf(replyStyle == null, "回复样式不能为空");
        this.replyStyle = replyStyle;
        this.updateAt = Instant.now();
    }

    public void throwIf(boolean condition, String message){
        if (condition) {
            throw new ClientException(message);
        }
    }

}
