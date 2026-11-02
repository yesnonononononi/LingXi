package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.ibatis.type.JdbcType;

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
    /** 本轮模型调用的响应身份（框架下发 String）；只挂在 AI 行 */
    private String responseId;
    private String resumeRequestId;

    private Long sessionId;
    /** 消息所属的业务轮次 ID（关联 chat_turn.id）；旧数据为 null 表示归属未知 */
    private Long turnId;
    private String type;
    /** 展示消息正文（含长回答）：按 CLOB 保存。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String content;
    private Instant createTime;
    private Instant updateTime;
}
