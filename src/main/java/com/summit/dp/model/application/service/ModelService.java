package com.summit.dp.model.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.user_configs.application.vo.SettingsView;


public interface ModelService {
    /** 运行期保留原始凭据，不得从接口返回。 */
    com.summit.core.conf.ModelConfig runtimeConfig(Long id, SettingsView settings);
    RuntimeModel resolveRuntimeConfig(Long id, SettingsView settings);
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
