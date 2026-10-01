package com.summit.dp.turn.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

import java.time.Instant;

/** ChatTurn MyBatis Mapper。 */
@Mapper
public interface ChatTurnMapper extends BaseMapper<ChatTurnPO> {

    /**
     * 崩溃收尸：把仍停留在 ACCEPTED / RUNNING 的轮次条件更新为失败终态并写结束时间。
     *
     * <p>进程崩溃重启后，这些轮次没有任何线程再负责收尾；不收口就会永远显示「执行中」。
     * 条件更新是安全边界：**WAITING 不在条件内** —— 挂起对应框架 SUSPENDED，是可恢复状态，
     * 误标失败会让「待恢复」入口消失。已终态的行同样不在条件内，幂等。</p>
     *
     * <p>状态值全部由 {@link Param} 传入，无任何外部输入拼接。</p>
     *
     * @return 实际被收口的行数
     */
    @Update("UPDATE chat_turn SET status = #{failedStatus}, completed_at = #{completedAt} "
            + "WHERE status IN (#{accepted}, #{running})")
    int markOrphansFailed(@Param("failedStatus") String failedStatus,
                          @Param("accepted") String accepted,
                          @Param("running") String running,
                          @Param("completedAt") Instant completedAt);
}
