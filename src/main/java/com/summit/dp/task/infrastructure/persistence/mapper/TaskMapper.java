package com.summit.dp.task.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.Collection;
import java.util.List;

@Mapper
public interface TaskMapper extends BaseMapper<TaskPO> {

    /**
     * 取「可能仍有终态结果待注入」的会话 id 集合（去重）。
     *
     * <p>回执存在执行属性里、不可查，所以「已注入过」只能<b>推断</b>：若有执行在该任务完成之后
     * 结束（{@code execution.completed_at >= task.complete_at}），说明后续轮次已经跑过一轮，
     * 注入发生在轮次起点，这批任务结果视为已消费。这是保守的反向判据 —— 它只会把「之后确实
     * 有执行跑完」的会话排除掉，不排除时会多唤醒一次（唤醒本身幂等），排除错了才会漏唤醒，
     * 因此用例必须同时覆盖「有终态任务且未被注入」的正向唤醒与「历史已注入」的负向不唤醒。</p>
     *
     * <p>状态集合与时间比较全部走 {@link Param} 绑定，无外部输入拼接；一次查询取候选，
     * 不随历史会话数逐会话查询。</p>
     *
     * @param terminalStatuses {@code task.status} 的终态编码集合
     * @return 去重后的会话 id，无候选返回空列表
     */
    @Select("<script>"
            + "SELECT DISTINCT t.session_id FROM task t"
            + " WHERE t.status IN "
            + "<foreach collection='terminalStatuses' item='status' open='(' separator=',' close=')'>#{status}</foreach>"
            + " AND t.complete_at IS NOT NULL"
            + " AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.session_id = t.session_id"
            + "   AND e.completed_at IS NOT NULL AND e.completed_at >= t.complete_at)"
            + "</script>")
    List<Long> selectSessionIdsWithUnconsumedTerminalTasks(@Param("terminalStatuses") Collection<String> terminalStatuses);
}
