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
    private Long sessionId;
    private String type;
    private String content;
    private Instant createTime;
    private Instant updateTime;
}
