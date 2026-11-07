package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface SessionMessageMapper extends BaseMapper<SessionMessagePO> {
    /** 会话消息条数：子会话卡片只需一个数字，不拉取消息正文。 */
    @Select("SELECT COUNT(*) FROM session_message WHERE session_id = #{sessionId}")
    long countBySessionId(@Param("sessionId") Long sessionId);

    /**
     * 批量插入（一条往返）。
     *
     * <p><b>为什么显式写全列</b>：主键是应用层预生成的雪花（{@code IdType.INPUT}），批量写入不依赖
     * 驱动回填；列顺序与 PO 字段一一对应，落库后 ID 不丢不重排。{@code content} 必须带
     * {@link com.summit.dp.shared.persistence.handler.LargeTextTypeHandler}，否则 CLOB 列会退回
     * 内置 String 处理器。</p>
     *
     * @param rows 待插入行；调用方保证非空
     * @return 实际插入行数
     */
    @Insert("<script>"
            + "INSERT INTO session_message "
            + "(id, response_id, resume_request_id, session_id, turn_id, type, content, create_time) VALUES "
            + "<foreach collection='rows' item='row' separator=','>"
            + "(#{row.id}, #{row.responseId}, #{row.resumeRequestId}, #{row.sessionId}, #{row.turnId},"
            + " #{row.type},"
            + " #{row.content,jdbcType=CLOB,typeHandler=com.summit.dp.shared.persistence.handler.LargeTextTypeHandler},"
            + " #{row.createTime})"
            + "</foreach>"
            + "</script>")
    int insertBatch(@Param("rows") List<SessionMessagePO> rows);
}
