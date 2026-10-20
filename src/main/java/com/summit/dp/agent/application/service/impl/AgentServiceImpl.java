package com.summit.dp.agent.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.AgentBatchModelCommand;
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
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/** Agent 应用层服务实现（生成骨架） */
@Service
@RequiredArgsConstructor
@Slf4j
public class AgentServiceImpl implements AgentService {

    /** 与前端 {@code isOk} 对齐的成功业务码 */
    private static final int SUCCESS_CODE = 1;

    private final AgentRepository repository;
    private final AgentValidator validator;

        @Override
    public Result<AgentVO> findById(Long id) {
        throwIf(id == null, "Agent标识不能为空");
        Agent model = repository.findById(id)
                .orElseThrow(() -> new ClientException("Agent不存在: " + id));
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
                .orElseThrow(() -> new ClientException("Agent不存在: " + command.getId()));
        repository.updateById(applyChanges(command, agent));
        return Result.success();
    }

    /**
     * 批量改基座模型。
     *
     * <p>先按 id 全量取回再逐条走领域方法：只要有一个 id 取不到就整体失败 ——
     * 部分成功会让用户以为「都改了」，回头发现有人还是旧模型，比直接报错更难排查。</p>
     */
    @Override
    @Transactional(rollbackFor = Exception.class)
    public Result<Integer> changeModelBatch(AgentBatchModelCommand command) {
        String error = validator.validateForBatchChangeModel(command);
        if (error != null) throw new ClientException(error);

        List<Long> ids = command.getIds().stream().distinct().toList();
        List<Agent> agents = new ArrayList<>(repository.findList(ids));
        throwIf(agents.size() != ids.size(), "部分智能体不存在，请刷新列表后重试");

        for (Agent agent : agents) {
            agent.changeModelId(command.getModelId());
        }
        repository.update(agents);
        log.info("批量设置智能体模型: count={}, modelId={}", agents.size(), command.getModelId());
        // 必须走两参重载：`success(Integer)` 是「只设业务码」的版本，
        // 写成 `success(agents.size())` 会让条数落进 code、data 恒为 null。
        return Result.success(SUCCESS_CODE, agents.size());
    }

    @Override
    public Result<Void> delById(Long id) {
        throwIf(id == null, "Agent标识不能为空");
        repository.findById(id).ifPresent(repository::delete);
        return Result.success();
    }

    @Override
    public Result<List<AgentVO>> queryIn(Collection<Long> ids) {
        if (ids == null || ids.isEmpty())
            return Result.success(List.of());
        return Result.success(repository.findList(ids).stream().map(this::toVO).toList());
    }
        /** 只应用本次传入（非 null）的字段；未传入表示不修改。 */
    private Agent applyChanges(AgentCommand command, Agent agent) {
        if (command.getDescription() != null) agent.changeDescription(command.getDescription());
        if (command.getName() != null) agent.changeName(command.getName());
        if (command.getModelId() != null) agent.changeModelId(command.getModelId());
        if (command.getToolList() != null) agent.changeTools(command.getToolList());
        if (command.getPrompt() != null) agent.changePrompt(command.getPrompt());
        if (command.getAvatar() != null) agent.changeAvatar(command.getAvatar());
        return agent;
    }

    /** 入口校验：不满足即抛业务异常，统一走全局异常处理器返回。 */
    private void throwIf(boolean condition, String error) {
        if (condition) throw new ClientException(error);
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
                .avatar(command.getAvatar())
                .build();
    }
}
