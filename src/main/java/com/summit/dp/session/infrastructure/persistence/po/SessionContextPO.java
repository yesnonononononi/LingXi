package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
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
    /**
     * 旧版正文列，只为迁移保留：启动时把非空行搬成 JSONL 文件后就置空，新写入永不触碰。
     *
     * <p>留在映射里是因为迁移要读它一次；{@code null} 时 MyBatis-Plus 不会把它拼进 INSERT/UPDATE，
     * 所以这里不需要额外的手工排除。</p>
     */
    /**
     * {@code updateStrategy = ALWAYS} 是刻意的：领域模型不再携带正文，任何一次替换都要把这一列改成
     * {@code NULL}。否则「替换先于迁移发生」的行会永远带着旧 CLOB，既占地又再没人读。
     */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class,
            updateStrategy = FieldStrategy.ALWAYS)
    private String content;
    /** 正文标识（数据目录下 {@code session-context/<session_id>/<正文标识>.jsonl}），库内只存它。 */
    private String snapshotFile;
    private Long version;
    private Instant createTime;
    private Instant updateTime;
}
