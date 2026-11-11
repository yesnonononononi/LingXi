package com.summit.dp.workflow.infrastructure.tools.file.record.persistence;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.Instant;
import java.util.List;

/**
 * 文件编辑记录读写。
 *
 * <p><b>排序责任在 SQL</b>：{@link #listByExecution} 一律 {@code ORDER BY seq}，
 * 差异重放按写入顺序叠加，任何调用方都不需要也不允许再排序。</p>
 */
@Mapper
public interface FileRecordMapper extends BaseMapper<FileRecordPO> {

    /** 按写入顺序取一次执行的全部记录。 */
    @Select("SELECT * FROM file_record WHERE execution_id = #{executionId} ORDER BY seq")
    List<FileRecordPO> listByExecution(@Param("executionId") String executionId);

    /**
     * 按写入顺序取一轮的记录。
     *
     * <p>窄查询：单轮汇总只需要本轮的记录，用 {@link #listByExecution} 再把其它轮次过滤掉，
     * 会把它们的基线大文本一并读进内存（长会话下就是这个形态的 OOM）。{@code turnId} 为
     * {@code null} 的记录属于「无轮次」那一桶，因此判空要和等值判定一起写。</p>
     */
    @Select("SELECT * FROM file_record WHERE execution_id = #{executionId}"
            + " AND (turn_id = #{turnId,jdbcType=VARCHAR}"
            + " OR (turn_id IS NULL AND #{turnId,jdbcType=VARCHAR} IS NULL)) ORDER BY seq")
    List<FileRecordPO> listByTurn(@Param("executionId") String executionId,
                                  @Param("turnId") String turnId);

    /** 按业务标识取单条（按执行隔离，避免跨执行的标识碰撞读到别人的记录）。 */
    @Select("SELECT * FROM file_record WHERE execution_id = #{executionId} AND id = #{id}")
    FileRecordPO selectByExecutionAndId(@Param("executionId") String executionId, @Param("id") String id);


    /** 同一文件的下一个版本号；由存储分配，调用方不能自行编造。 */
    @Select("SELECT COALESCE(MAX(version), 0) FROM file_record WHERE execution_id = #{executionId} "
            + "AND file_path = #{filePath}")
    int maxVersion(@Param("executionId") String executionId, @Param("filePath") String filePath);

    /** 过期回收候选：只取标识与基线路径，不读 diff 正文。 */
    @Select("SELECT id, execution_id, baseline_path FROM file_record WHERE create_at < #{cutoff}")
    List<FileRecordPO> listCreatedBefore(@Param("cutoff") Instant cutoff);

    /** 过期记录条数：清理预览用，不读任何正文。 */
    @Select("SELECT COUNT(*) FROM file_record WHERE create_at < #{cutoff}")
    long countCreatedBefore(@Param("cutoff") Instant cutoff);

}
