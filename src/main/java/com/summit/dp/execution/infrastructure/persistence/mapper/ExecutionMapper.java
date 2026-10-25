package com.summit.dp.execution.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.ExecutionStatusCodes;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Result;
import org.apache.ibatis.annotations.Results;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.Collection;
import java.util.List;

/**
 * Execution MyBatis Mapper（生成骨架）
 */
@Mapper
public interface ExecutionMapper extends BaseMapper<ExecutionPO> {

    // 已删除会话可能残留轮次；只有仍属于有效会话的历史才提供重发入口。
    String RECLAIMABLE = " status IN (" + ExecutionStatusCodes.COMPLETED + ","
            + ExecutionStatusCodes.FAILED + "," + ExecutionStatusCodes.CANCELLED + ")"
            + " AND NOT EXISTS (SELECT 1 FROM chat_turn t JOIN session s ON s.id = t.session_id"
            + " WHERE t.execution_id = execution.id)"
            + " AND NOT EXISTS (SELECT 1 FROM tool_call c WHERE c.execution_id = execution.id)"
            + " AND NOT EXISTS (SELECT 1 FROM execution_resume_task r WHERE r.execution_id = execution.id)"
            + " AND NOT EXISTS (SELECT 1 FROM task b WHERE b.execution_id = execution.id)";

    @Select("SELECT COUNT(*) FROM execution WHERE" + RECLAIMABLE)
    long countReclaimable();

    @Select("SELECT id, version, status FROM execution WHERE id > #{afterId} AND" + RECLAIMABLE
            + " ORDER BY id LIMIT #{limit}")
    List<ExecutionPO> findReclaimable(@Param("afterId") long afterId, @Param("limit") int limit);

    @Delete("DELETE FROM execution WHERE id = #{id} AND version = #{version} AND" + RECLAIMABLE)
    int deleteReclaimable(@Param("id") long executionId, @Param("version") long version);

    /**
     * 收口孤儿执行：进程崩溃重启后，仍停留在 CREATED / RUNNING 的执行没有任何线程再负责收尾，
     * 条件更新为失败终态（FAILED）。
     *
     * <p>状态值全部由 {@link Param} 传入，无任何外部输入拼接。SUSPENDED 与已终态行不在
     * 条件内，绝对不被触碰——误标 SUSPENDED 会让「待恢复」入口消失。幂等：重复执行
     * 第二次命中 0 行。{@code updated_at} 由列的 {@code ON UPDATE CURRENT_TIMESTAMP(3)}
     * 自动维护，无需显式赋值。</p>
     *
     * @return 实际被收口的行数
     */
    @Update("UPDATE execution SET status = #{failedStatus}, version = version + 1 WHERE status IN (#{created}, #{running})")
    int markOrphanRunsFailed(@Param("failedStatus") int failedStatus,
                             @Param("created") int created,
                             @Param("running") int running);

    /**
     * 批量查询每个会话、每种状态下最新的执行，复用 ExecutionPO 接收轻量列。
     *
     * <p>按 session_id/status 分区取第一条，再按 id 降序返回。六种已知状态最多返回六条，
     * 进行态与终态都不会因历史长度而丢失；分类规则留在应用层。单表查询，不加载 snapshot。
     * sessionIds 必须非空，由仓储层短路。</p>
     */
    @Select("<script>"
            + "SELECT id, session_id, status, created_at FROM ("
            + "  SELECT id, session_id, status, created_at,"
            + "         ROW_NUMBER() OVER (PARTITION BY session_id, status ORDER BY id DESC) AS rn"
            + "  FROM execution"
            + "  WHERE session_id IN "
            + "  <foreach collection='sessionIds' item='sid' open='(' separator=',' close=')'>#{sid}</foreach>"
            + ") ranked WHERE ranked.rn = 1"
            + " ORDER BY ranked.session_id ASC, ranked.id DESC"
            + "</script>")
    @Results({
            @Result(column = "id", property = "id", id = true),
            @Result(column = "session_id", property = "sessionId"),
            @Result(column = "status", property = "status"),
            @Result(column = "created_at", property = "createdAt")
    })
    List<ExecutionPO> selectLatestBySessionAndStatus(@Param("sessionIds") Collection<Long> sessionIds);
}
