package com.summit.dp.checklist.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.Instant;

/** 写入前先锁父行，步骤读取与聚合裁决才能基于同一次提交。 */
@Mapper
public interface ChecklistMapper extends BaseMapper<ChecklistPO> {

    /** 父行锁持有到事务结束，再读取步骤。 */
    @Select("SELECT * FROM checklist WHERE id = #{id} FOR UPDATE")
    ChecklistPO selectByIdForUpdate(@Param("id") long id);

    /** 活动行不存在时不产生锁，首次创建仍由唯一索引裁决。 */
    @Select("SELECT * FROM checklist WHERE session_id = #{sessionId} AND status = 'ACTIVE' FOR UPDATE")
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
