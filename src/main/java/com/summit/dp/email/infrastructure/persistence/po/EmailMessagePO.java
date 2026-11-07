package com.summit.dp.email.infrastructure.persistence.po;

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

/**
 * EmailMessage 持久化对象，映射 {@code email_message} 表。
 * <p>时间列命名与 DDL 对齐（create_at/update_at），主键为应用层生成的雪花 id。</p>
 *
 * <p>无参与全参构造器是给 MyBatis 用的：没有无参构造器时它改走「按列序匹配构造器」，
 * 遇到列裁剪的窄查询（只选 id、email_id）会直接映射失败。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("email_message")
public class EmailMessagePO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long emailId;
    private Long senderId;
    private String dedupKey;
    /** 团队邮件正文（含长指令）：H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String content;
    private String status;
    private Instant createAt;
    private Instant updateAt;
}
