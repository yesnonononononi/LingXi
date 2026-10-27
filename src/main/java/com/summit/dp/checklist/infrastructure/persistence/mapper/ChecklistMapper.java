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
 * <p>锁与 CAS 必须写成 SQL：这两件事的语义都在数据库一侧（行锁、条件更新的影响行数），
 * 用「先查后改」在应用层模拟等于没有。</p>
 */
@Mapper
public interface ChecklistMapper extends BaseMapper<ChecklistPO> {

    /** 锁住清单行：所有写入口都从这里开始，步骤读取才有一致性可言。 */
    @Select("SELECT * FROM checklist WHERE id = #{id} FOR UPDATE")
    ChecklistPO selectByIdForUpdate(@Param("id") long id);

    /** 锁住会话内的活动清单行；不存在返回 null。 */
    @Select("SELECT * FROM checklist WHERE session_id = #{sessionId} AND status = 'ACTIVE' FOR UPDATE")
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
