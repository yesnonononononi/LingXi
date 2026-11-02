package com.summit.dp.checklist.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.Instant;

/** 清单并发通过监视器、唯一索引与条件更新裁决，避免混用多套锁顺序。 */
@Mapper
public interface ChecklistMapper extends BaseMapper<ChecklistPO> {

    /** 读清单行；并发写由随后的条件更新裁决，见类注释。 */
    @Select("SELECT * FROM checklist WHERE id = #{id}")
    ChecklistPO selectByIdForUpdate(@Param("id") long id);

    /** 读会话内的活动清单行；不存在返回 null。 */
    @Select("SELECT * FROM checklist WHERE session_id = #{sessionId} AND status = 'ACTIVE'")
    ChecklistPO selectActiveBySessionIdForUpdate(@Param("sessionId") long sessionId);

    /** 条件变化时返回 0，调用方必须重查，不能据此认定提醒已经送达。 */
    @Update("UPDATE checklist SET remind_status = 1, remind_execution_id = #{executionId,jdbcType=BIGINT}, "
            + "reminded_progress_version = progress_version, update_at = #{updateAt,jdbcType=TIMESTAMP} "
            + "WHERE id = #{id} AND session_id = #{sessionId} AND status = 'ACTIVE' "
            + "AND progress_version = #{progressVersion} AND remind_status = 0")
    int claimReminder(@Param("id") long id, @Param("sessionId") long sessionId,
                      @Param("progressVersion") long progressVersion, @Param("executionId") long executionId,
                      @Param("updateAt") Instant updateAt);
}
