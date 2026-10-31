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

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("session_context")
public class SessionContextPO {
    @TableId(type = IdType.INPUT)
    private Long sessionId;
    /** 模型上下文全文：历史样本超过 1000 万字符，H2 侧必须是 CLOB（TEXT 会退化成 10 亿字符的 VARCHAR）。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String content;
    private Long version;
    private Instant createTime;
    private Instant updateTime;
}
