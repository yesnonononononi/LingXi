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

    /**
     * 原子占用提醒额度。
     *
     * <p>影响行数为 1 表示本次拿到了额度；为 0 表示条件不再成立（额度已被用掉）。
     * 归属执行与提醒版本必须和状态一起写入，否则后续无法区分「本执行已提醒」与「别的执行持有提醒」。</p>
     */
    @Update("UPDATE checklist SET remind_status = TRUE, remind_execution_id = #{executionId,jdbcType=BIGINT}, "
            + "reminded_progress_version = progress_version, update_at = #{updateAt,jdbcType=TIMESTAMP} "
            + "WHERE id = #{id} AND remind_status = FALSE")
    int claimReminder(@Param("id") long id, @Param("executionId") Long executionId,
                      @Param("updateAt") Instant updateAt);
}
