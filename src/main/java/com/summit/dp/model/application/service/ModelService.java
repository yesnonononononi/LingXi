package com.summit.dp.model.application.service;

import cn.hutool.db.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.command.UpdateModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;

import java.util.List;

public interface ModelService {
    Result<Void> add(ModelConfigCommand command);
    Result<Void> update(UpdateModelConfigCommand command);
    Result<Void> del(Long id);
    Result<PageResult<List<ModelConfigVO>>> list(Integer page, Integer pageSize);
    Result<ModelConfigVO> findById(Long id);
}
