package com.summit.dp.agent.application.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;

/**
 * 一次聊天请求的受理回执。
 *
 * <p>受理是「请求线程同步完成后立刻返回」的那一刻：会话已确定、用户消息与业务轮次已同事务
 * 落库；模型调用随后异步进行，前端凭这份回执把实时事件与历史对齐。</p>
 *
 * <p>两个 ID 都是雪花值，超出 JS 安全整数范围，一律下成字符串，前端不得拿到被截断的 Long。</p>
 */
@Data
@Builder
public class ChatAcceptanceVO {

    /** 本次轮次所属会话 ID（新建会话时即其权威雪花 ID）。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long sessionId;

    /** 本次受理创建的业务轮次 ID；与落库轮次一致，是前端对齐事件与历史的键。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long turnId;
}
