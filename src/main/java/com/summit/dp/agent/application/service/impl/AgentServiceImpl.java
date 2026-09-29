package com.summit.dp.agent.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.AgentCommand;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;

import java.util.Collection;
import java.util.List;

/** Agent 应用层服务实现（生成骨架） */
@Service
@RequiredArgsConstructor
@Slf4j
public class AgentServiceImpl implements AgentService {

    private final AgentRepository repository;
    private final AgentValidator validator;

    @Override
    public Result<AgentVO> findById(Long id) {
        if (id == null)
            throw new ClientException("id is null");
        Agent model = repository.findById(id)
                .orElseThrow(() -> new ClientException("id 对应数据不存在: " + id));
        return Result.success(toVO(model));
    }

    @Override
    public Result<PageResult<AgentVO>> findPage(Integer page, Integer pageSize) {
        int current = page == null ? 1 : Math.max(page, 1);
        int size = pageSize == null ? 10 : Math.max(pageSize, 1);
        IPage<Agent> pageResult = repository.queryByPage(current, size);
        PageResult<AgentVO> result = new PageResult<>(pageResult.getCurrent(), pageResult.getSize(),
                pageResult.getTotal(), pageResult.getRecords().stream().map(this::toVO).toList());
        return Result.success(result);
    }

    @Override
    public Result<Void> add(AgentCommand command) {
        String error = validator.validateForCreate(command);
        if (error != null) throw new ClientException(error);
        Agent model = toModel(command);
        model.changeStatus(Agent.STATUS_ENABLED);
        repository.save(model);
        return Result.success();
    }

    @Override
    public Result<Void> update(AgentCommand command) {
        String error = validator.validateForUpdate(command);
        if (error != null) throw new ClientException(error);
        Agent agent = repository.findById(command.getId())
                .orElseThrow(() -> new ClientException("id 对应数据不存在: " + command.getId()));
        Agent model = update(command, agent);
        repository.updateById(model);
        return Result.success();
    }

    @Override
    public Result<Void> delById(Long id) {
        if (id == null)
            throw new ClientException("id is null");
        repository.findById(id).ifPresent(repository::delete);
        return Result.success();
    }

    @Override
    public Result<List<AgentVO>> queryIn(Collection<Long> ids) {
        if (ids == null || ids.isEmpty())
            return Result.success(List.of());
        return Result.success(repository.findList(ids).stream().map(this::toVO).toList());
    }
    public Agent update(AgentCommand agentCommand,Agent agent){
        if(agentCommand.getDescription() != null) agent.changeDescription(agentCommand.getDescription());
        if(agentCommand.getName() != null) agent.changName(agentCommand.getName());
        if(agentCommand.getModelId() != null) agent.changeModelId(agentCommand.getModelId());
        if(agentCommand.getToolList() != null) agent.changeTools(agentCommand.getToolList());
        if(agentCommand.getPrompt() != null) agent.changePrompt(agentCommand.getPrompt());
        return agent;
    }

    private AgentVO toVO(Agent model) {
        AgentVO vo = new AgentVO();
        BeanUtils.copyProperties(model, vo);
        return vo;
    }

    private Agent toModel(AgentCommand command) {
         return Agent.builder()
                 .id(command.getId())
                 .name(command.getName())
                 .modelId(command.getModelId())
                 .toolList(command.getToolList())
                 .prompt(command.getPrompt())
                 .description(command.getDescription())
                 .build();
    }
}
