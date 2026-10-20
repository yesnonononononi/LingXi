package com.summit.dp.model.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.application.vo.ProviderModelGroupVO;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.user_configs.application.vo.SettingsView;

import java.util.List;


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
     * 提供商 + 模型的聚合视图：按 provider_config 分组，供模型配置页与输入框上拉框共用。
     * 未归属（含预设已删除的悬空引用）统一归入末尾的「未分组」。
     */
    Result<List<ProviderModelGroupVO>> catalog();

    /**
     * 清除指定模型的 API 凭据（凭据三态之「清除」，供 {@code DELETE /settings/model/credential}）。
     * 模型不存在时抛业务异常，不做静默成功。
     */
    Result<Void> clearCredential(Long id);
}
