package com.summit.dp.execution.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Result;
import org.apache.ibatis.annotations.Results;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.List;

/**
 * Execution MyBatis Mapper（生成骨架）
 */
@Mapper
public interface ExecutionMapper extends BaseMapper<ExecutionPO> {

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
     * 收口「尚未终结就被中断」的执行：把 CREATED / RUNNING 条件更新为失败终态，并写下结束时间。
     *
     * <p>用在启动失败路径：编排器在框架 loop 起来之前就抛异常（例如 Agent 解析不到、模型配置缺失），
     * 此时执行行还停在 CREATED，若不收口，历史里会留下一条永远「创建中」的记录。</p>
     *
     * <p><b>条件更新是安全边界</b>：只命中 CREATED / RUNNING。已经 COMPLETED 的执行不会被改写；
     * SUSPENDED 也不在条件内 —— 挂起是可恢复状态，误标失败会让「待恢复」入口消失。
     * 状态值与结束时间全部由 {@link Param} 传入，无任何外部输入拼接；重复调用幂等。</p>
     *
     * @return 实际被收口的行数（0 表示该执行已经自己走到了终态，或行还不存在）
     */
    @Update("UPDATE execution SET status = #{failedStatus}, completed_at = #{completedAt}, version = version + 1 "
            + "WHERE id = #{id} AND status IN (#{created}, #{running})")
    int markFailedIfUnfinished(@Param("id") long id,
                               @Param("failedStatus") int failedStatus,
                               @Param("created") int created,
                               @Param("running") int running,
                               @Param("completedAt") LocalDateTime completedAt);

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
