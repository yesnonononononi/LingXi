package com.summit.dp.checklist.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.Instant;

/**
 * 清单行 Mapper。
 *
 * <p>CAS 必须写成 SQL：条件更新的影响行数是「谁赢」的唯一裁决点，用「先查后改」在应用层模拟等于没有。</p>
 *
 * <p><b>为什么没有 {@code SELECT ... FOR UPDATE}</b>：SQLite 没有行锁，写事务本身就是库级排他。
 * 原先靠行锁串行化的入口，退化为「读 → 条件更新（带 version / 状态 / progress_version）」，
 * 竞争失败方由影响行数 0 判定，不再有锁等待。</p>
 */
@Mapper
public interface ChecklistMapper extends BaseMapper<ChecklistPO> {

    /** 读清单行；并发写由随后的条件更新裁决，见类注释。 */
    @Select("SELECT * FROM checklist WHERE id = #{id}")
    ChecklistPO selectByIdForUpdate(@Param("id") long id);

    /** 读会话内的活动清单行；不存在返回 null。 */
    @Select("SELECT * FROM checklist WHERE session_id = #{sessionId} AND status = 'ACTIVE'")
    ChecklistPO selectActiveBySessionIdForUpdate(@Param("sessionId") long sessionId);

    /** 条件变化时返回 0，调用方必须重查，不能据此认定提醒已经送达。 */
    @Update("UPDATE checklist SET remind_status = TRUE, remind_execution_id = #{executionId,jdbcType=BIGINT}, "
            + "reminded_progress_version = progress_version, update_at = #{updateAt,jdbcType=TIMESTAMP} "
            + "WHERE id = #{id} AND session_id = #{sessionId} AND status = 'ACTIVE' "
            + "AND progress_version = #{progressVersion} AND remind_status = FALSE")
    int claimReminder(@Param("id") long id, @Param("sessionId") long sessionId,
                      @Param("progressVersion") long progressVersion, @Param("executionId") long executionId,
                      @Param("updateAt") Instant updateAt);
}
