package com.summit.dp.execution.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.Collection;
import java.util.List;

/** {@code execution_resume_task} 表 Mapper。 */
@Mapper
public interface ExecutionResumeTaskMapper extends BaseMapper<ExecutionResumeTaskPO> {

    /**
     * 按状态集合取未完成的恢复请求，按 id 升序取前 {@code limit} 条。
     *
     * <p>状态集合与行数上限都由 {@link Param} 绑定：这是启动巡检的热路径，不拼接任何外部值 ——
     * 拼接既绕开预编译，也让 SQL 无法被 MyBatis 缓存复用。</p>
     *
     * @param states 视为「未完成」的状态值集合；调用方保证非空
     * @param limit  行数上限，调用方已夹到有界范围
     * @return 命中的请求行，按 id 升序
     */
    @Select("<script>"
            + "SELECT * FROM execution_resume_task WHERE state IN "
            + "<foreach collection='states' item='state' open='(' separator=',' close=')'>#{state}</foreach>"
            + " ORDER BY id LIMIT #{limit}"
            + "</script>")
    List<ExecutionResumeTaskPO> listUnfinished(@Param("states") Collection<String> states,
                                               @Param("limit") int limit);
}
