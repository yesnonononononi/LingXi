package com.summit.dp.execution.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.vo.ExecutionVO;
import java.util.List;

/**
 * 执行记录查询。
 *
 * <p>暂停 / 取消不再经过本服务：本地模式下控制指令由框架进程内的
 * {@code ExecutionControl}（基于 {@code ExecutionControlSignal}）直接投递给正在运行的 loop。</p>
 */
public interface ExecutionService {
    Result<ExecutionVO> findById(Long id);
    Result<PageResult<ExecutionVO>> findPage(Integer page, Integer pageSize);
    Result<List<ExecutionVO>> findRecentBySession(Long sessionId, int limit);
}
