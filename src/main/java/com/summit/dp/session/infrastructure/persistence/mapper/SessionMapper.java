package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface SessionMapper extends BaseMapper<SessionPO> {
    /**
     * 排序必须先于分页；最新进行态与展示口径一致，避免历史运行记录把挂起会话置顶。
     *
     * <p><b>置顶排在最前一级</b>：pin 是用户的显式意图，进行中只是瞬时状态 ——
     * 反过来的话，用户 pin 的会话会被任何一次运行中的其它会话压下去，pin 看起来没生效。</p>
     *
     * <p><b>{@code s.id DESC} 是全序的最后一级，不能删</b>：offset 分页的正确性只依赖
     * 「排序键两两可比且无并列」。删掉它，排序键相同的两行在两次查询里的先后 H2 不保证，
     * 同一行会同时出现在第 1 页和第 2 页，或者两页都漏掉。</p>
     */
    @Select("SELECT s.* FROM session s WHERE s.root_session_id = #{root}"
            + " ORDER BY CASE WHEN s.is_pinned THEN 0 ELSE 1 END,"
            + " CASE WHEN (SELECT e.status FROM execution e WHERE e.session_id = s.id"
            + " AND e.status IN (" + ExecutionStatusCodes.CREATED + "," + ExecutionStatusCodes.RUNNING
            + "," + ExecutionStatusCodes.SUSPENDED + ") ORDER BY e.id DESC LIMIT 1)"
            + " IN (" + ExecutionStatusCodes.CREATED + "," + ExecutionStatusCodes.RUNNING + ") THEN 0 ELSE 1 END,"
            + " s.update_time DESC, s.id DESC LIMIT #{size} OFFSET #{offset}")
    List<SessionPO> selectRootPage(@Param("root") long rootSessionId, @Param("offset") long offset,
                                   @Param("size") long size);


    @Select("SELECT COUNT(*) FROM session WHERE root_session_id = #{root}")
    long countRoot(@Param("root") long rootSessionId);

    /**
     * 会话树：一次拿到根会话自身 + 其下全部子会话，平铺返回。
     * 走主键与 idx_root_session_id 两次常量等值查找；根会话保持 root_session_id = 0 语义，
     * 会话列表分页才能继续走 root_session_id = 0 的等值索引（避免列与列比较退化为全索引扫描）。
     */
    @Select("SELECT * FROM session WHERE id = #{root} OR root_session_id = #{root} ORDER BY id ASC")
    List<SessionPO> selectSessionTree(@Param("root") Long rootSessionId);

    /**
     * 按 (root_session_id, agent_id) 取最新一条子会话，走 idx_root_agent 联合索引。
     *
     * <p>{@code LIMIT 1} 与 {@code ORDER BY id DESC} 兜住「历史数据存在重复子会话」的情形：
     * 复用语义下只可能也应该复用最近在用的那个。参数由绑定传入，无拼接。</p>
     */
    @Select("SELECT * FROM session WHERE root_session_id = #{root} AND agent_id = #{agentId} ORDER BY id DESC LIMIT 1")
    SessionPO selectLatestByRootAndAgent(@Param("root") Long rootSessionId, @Param("agentId") Long agentId);
}
