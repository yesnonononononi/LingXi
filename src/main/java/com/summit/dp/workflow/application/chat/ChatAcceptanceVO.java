package com.summit.dp.workflow.application.chat;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;
import java.util.Set;

/** 已落库请求返回轮次 ID，待发送请求返回队列 ID。 */
@Data
@Builder
public class ChatAcceptanceVO {

    /** 本次轮次所属会话 ID（新建会话时即其权威雪花 ID）。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long sessionId;

    /** 本次受理创建的业务轮次 ID；与落库轮次一致，是前端对齐事件与历史的键。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long turnId;

    private String pendingId;

    @JsonSerialize(using = ToStringSerializer.class)
    private Long historyRevision;
    /** 重发只按服务端确认的范围清理界面，避免旧轮次被历史合并重新带回。 */
    private Set<String> invalidatedTurnIds;
    private Set<String> invalidatedExecutionIds;
}
