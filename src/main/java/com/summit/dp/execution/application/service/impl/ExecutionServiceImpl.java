package com.summit.dp.execution.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionService;
import com.summit.dp.execution.application.vo.ExecutionVO;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ExecutionServiceImpl implements ExecutionService {
    private final ExecutionRepository repository;

    @Override
    public Result<ExecutionVO> findById(Long id) {
        if (id == null) throw new ClientException("execution id is null");
        Execution value = repository.findById(id)
                .orElseThrow(() -> new ClientException("execution not found: " + id));
        return Result.success(toVO(value));
    }

    @Override
    public Result<PageResult<ExecutionVO>> findPage(Integer page, Integer pageSize) {
        IPage<Execution> pageResult = repository.queryByPage(page == null ? 1 : page,
                pageSize == null ? 10 : pageSize);
        return Result.success(new PageResult<>(pageResult.getCurrent(), pageResult.getSize(),
                pageResult.getTotal(), pageResult.getRecords().stream().map(this::toVO).toList()));
    }

    @Override
    public Result<List<ExecutionVO>> findRecentBySession(Long sessionId, int limit) {
        if (sessionId == null) throw new ClientException("session id is null");
        return Result.success(repository.findRecentBySession(sessionId, limit)
                .stream().map(this::toVO).toList());
    }

    private ExecutionVO toVO(Execution model) {
        ExecutionVO vo = new ExecutionVO();
        BeanUtils.copyProperties(model, vo);
        return vo;
    }
}
