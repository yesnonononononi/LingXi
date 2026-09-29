package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SessionMessageMapper extends BaseMapper<SessionMessagePO> {
    /** 会话消息条数：子会话卡片只需一个数字，不拉取消息正文。 */
    @Select("SELECT COUNT(*) FROM session_message WHERE session_id = #{sessionId}")
    long countBySessionId(@Param("sessionId") Long sessionId);
}
