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
     * <p>回执存在执行属性里、不可查，所以「已注入过」只能<b>推断</b>。注入必然发生在「该会话某一轮执行
     * <b>开始之后</b>的模型调用」里，因此排除条件是「存在一次<b>在本任务完成之后才开始、且正常完成</b>的执行」：
     * {@code execution.started_at > task.complete_at AND execution.status = completedStatus}。
     * 这样那一轮的首次模型调用必然已经注入过这批结果。</p>
     *
     * <p><b>为什么不是 {@code completed_at >= task.complete_at}</b>：任务的完成时刻可能落在某一轮执行
     * 的<b>最后一次模型调用之后</b>（后台命令刚好在收尾时结束）。该轮随后正常结束，于是
     * {@code completed_at >= task.complete_at} 成立，会话被误判为「已注入」而排除；但该轮此后没有再发生
     * 模型调用，结果从未被注入 —— 重启后它既不在「仍活跃」候选里、也不在这里，这条任务结果就<b>永久</b>
     * 不会被注入（相对旧的「扫全部会话」实现是可观测的回归）。改看 {@code started_at} 后，重叠轮次
     * （在任务完成前就已开始的轮次）不再被排除，上述漏唤醒场景被覆盖。</p>
     *
     * <p>仍然排除的只有「任务完成后重新起了一轮并跑完」；若那一轮在首次模型调用前就失败
     * （状态不是 COMPLETED），不会被排除，仍保留为候选。</p>
     *
     * <p>状态集合与时间比较全部走 {@link Param} 绑定，无外部输入拼接；一次查询取候选，
     * 不随历史会话数逐会话查询。</p>
     *
     * @param terminalStatuses {@code task.status} 的终态编码集合
     * @param completedStatus  {@code execution.status} 的正常完成编码，见 {@code ExecutionStatusCodes#COMPLETED}
     * @return 去重后的会话 id，无候选返回空列表
     */
    @Select("<script>"
            + "SELECT DISTINCT t.session_id FROM task t"
            + " WHERE t.status IN "
            + "<foreach collection='terminalStatuses' item='status' open='(' separator=',' close=')'>#{status}</foreach>"
            + " AND t.complete_at IS NOT NULL"
            + " AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.session_id = t.session_id"
            + "   AND e.started_at IS NOT NULL AND e.started_at > t.complete_at"
            + "   AND e.status = #{completedStatus})"
            + "</script>")
    List<Long> selectSessionIdsWithUnconsumedTerminalTasks(
            @Param("terminalStatuses") Collection<String> terminalStatuses,
            @Param("completedStatus") int completedStatus);
}
