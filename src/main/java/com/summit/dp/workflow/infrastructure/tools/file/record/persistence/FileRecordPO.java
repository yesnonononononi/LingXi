package com.summit.dp.workflow.infrastructure.tools.file.record.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.Data;
import org.apache.ibatis.type.JdbcType;

import java.time.Instant;

/**
 * 文件编辑记录表（V12）。
 *
 * <p><b>{@code seq} 才是主键，业务标识 {@code id} 只是唯一列</b>：记录标识是无序 UUID，
 * 而差异重放依赖写入顺序，所以顺序由库自增列承担，读侧一律 {@code ORDER BY seq}。</p>
 *
 * <p><b>基线只有路径</b>：{@code baseline_path} 指向数据目录下的基线文件（绝对路径），
 * 本表不存基线正文。{@code null} 表示新建文件或基线已过期回收 —— 两种情况在装配时都
 * 解析成 {@code baseline = null}，差异正文不会因此编造出「整份文件都是新增」的假象，
 * 因为过期回收是**整条记录**一起删的（见 {@code H2FileRecordStore#purgeBefore}）。</p>
 */
@Data
@TableName("file_record")
public class FileRecordPO {

    @TableId(type = IdType.AUTO)
    private Long seq;
    private String id;
    private String executionId;
    private String turnId;
    private Integer version;
    private String filePath;
    private String baselinePath;
    /** 这一次编辑的 unified diff：可能很长，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String diff;
    /** 增删行数：列是 NOT NULL，用原始类型，省掉读侧的空值兜底。 */
    private int plusLines;
    private int minusLines;
    private Instant createAt;
}
