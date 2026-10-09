package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import lombok.*;
import java.time.Instant;
@Builder
@Data
@NoArgsConstructor
@AllArgsConstructor
@TableName("session_message")
public class SessionMessagePO {
    /** 雪花ID：全局趋势递增，兼作消息排序键与游标分页键 */
    @TableId(type = IdType.INPUT)
    private Long id;
    /** 本轮模型调用的响应身份（框架下发 String）；只挂在 AI 行，null 表示身份未知 */
    private String responseId;

    private Long sessionId;
    /** 消息所属的业务轮次 ID（关联 chat_turn.id）；旧数据为 null 表示归属未知 */
    private Long turnId;
    /** 本轮模型调用在一轮内的序号（0 基）；只挂 AI 行，null 表示未知（旧数据） */
    private Integer responseOrder;
    private String type;
    private String content;
    private Instant createTime;
    private Instant updateTime;
}
