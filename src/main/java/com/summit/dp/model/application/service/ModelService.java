package com.summit.dp.model.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;


public interface ModelService {
    /** Internal runtime configuration with the original credential; never return it from an API. */
    com.summit.core.conf.ModelConfig runtimeConfig(Long id, com.summit.dp.shared.context.SettingsView settings);
    Result<Void> add(ModelConfigCommand command);
    Result<Void> update(ModelConfigCommand command);
    Result<Void> del(Long id);
    Result<PageResult<ModelConfigVO>> list(Integer page, Integer pageSize);
    Result<ModelConfigVO> findById(Long id);

    /**
     * 清除指定模型的 API 凭据（凭据三态之「清除」，供 {@code DELETE /settings/model/credential}）。
     * 模型不存在时抛业务异常，不做静默成功。
     */
    Result<Void> clearCredential(Long id);
}
