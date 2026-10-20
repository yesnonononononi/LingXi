package com.summit.dp.agent.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.AgentBatchModelCommand;
import com.summit.dp.agent.application.command.AgentCommand;
import com.summit.dp.agent.application.vo.AgentVO;

import java.util.Collection;
import java.util.List;

/** Agent 应用层服务接口（生成骨架） */
public interface AgentService {
    Result<AgentVO> findById(Long id);

    Result<PageResult<AgentVO>> findPage(Integer page, Integer pageSize);

    Result<Void> add(AgentCommand command);

    Result<Void> update(AgentCommand command);

    /** 批量把多个智能体的基座模型改成同一个，返回实际更新条数。 */
    Result<Integer> changeModelBatch(AgentBatchModelCommand command);


    Result<Void> delById(Long id);

    Result<List<AgentVO>> queryIn(Collection<Long> ids);
}
