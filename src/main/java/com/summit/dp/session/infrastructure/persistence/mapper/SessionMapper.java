package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface SessionMapper extends BaseMapper<SessionPO> {
    /** 根会话分页：子代理会话不参与列表展示，按主键倒序。 */
    @Select("SELECT * FROM session WHERE root_session_id = #{root} ORDER BY id DESC LIMIT #{offset}, #{size}")
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
}
