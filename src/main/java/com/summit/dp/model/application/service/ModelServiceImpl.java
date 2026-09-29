package com.summit.dp.model.application.service;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/** 模型配置与 API Key 明文保存到数据库；对外 VO 统一返回掩码。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ModelServiceImpl implements ModelService {
    private final ModelConfigRepository modelConfigRepository;

    @Override
    public Result<Void> add(ModelConfigCommand command) {
        ModelConfig modelConfig = new ModelConfig(null, command.baseUrl(),
                command.apiKey() == null ? "" : command.apiKey().trim(), command.modelName(), null);
        modelConfigRepository.save(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> update(ModelConfigCommand command) {
        ModelConfig modelConfig = modelConfigRepository.findById(command.id()).orElseThrow(ModelNoFoundException::new);
        // 编辑留空保留原值，清除仍走独立接口。
        String apiKey = hasCredential(command) ? command.apiKey().trim() : modelConfig.getApiKey();
        // 客户端回传展示值时不能把掩码写成实际密钥。
        if (apiKey != null && apiKey.equals(modelConfig.getMaskedApiKey())) apiKey = modelConfig.getApiKey();
        modelConfig.update(command.modelName(), command.baseUrl(), apiKey);
        modelConfigRepository.updateById(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> del(Long id) {
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        modelConfigRepository.delete(modelConfig);
        return Result.success();
    }

    @Override
    public Result<PageResult<ModelConfigVO>> list(Integer page, Integer pageSize) {
        int current = page == null || page < 1 ? 1 : page;
        int size = pageSize == null || pageSize < 1 ? 10 : pageSize;
        IPage<ModelConfig> pRes = modelConfigRepository.page(current, size);
        PageResult<ModelConfigVO> result = new PageResult<>(
                pRes.getCurrent(),
                pRes.getSize(),
                pRes.getTotal(),
                pRes.getRecords().stream().map(this::toVo).toList());
        return Result.success(result);
    }

    @Override
    public Result<ModelConfigVO> findById(Long id) {
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        ModelConfigVO vo = toVo(modelConfig);

        return Result.success(vo);
    }

    @Override
    public Result<Void> clearCredential(Long id) {
        // 模型必须存在：清除不存在模型的凭据要报错而不是静默成功（设计要求）。
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        modelConfig.update(modelConfig.getModelName(), modelConfig.getBaseUrl(), "");
        modelConfigRepository.updateById(modelConfig);
        return Result.success();
    }

    @Override
    public com.summit.core.conf.ModelConfig runtimeConfig(Long id,SettingsView settings) {
        if (id == null) throw new ClientException("未配置可用的模型连接");

        ModelConfig model = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);

        if (model.getBaseUrl() == null || model.getBaseUrl().isBlank()
                || model.getApiKey() == null || model.getApiKey().isBlank()
                || model.getModelName() == null || model.getModelName().isBlank()) {
            throw new ClientException("模型连接配置不完整: " + id);
        }
        // 思考开关未显式配置时走 ModelConfig 缺省（false）；如需用户级控制，后续在 SettingsView 增字段。
        com.summit.core.conf.ModelConfig.ModelConfigBuilder builder = com.summit.core.conf.ModelConfig.builder()
                .baseUrl(model.getBaseUrl())
                .apiKey(model.getApiKey())
                .modelName(model.getModelName())
                .returnThinking(true)
                .sendThinking(true)
                .provider(model.getProvider());


        if (settings != null) {
            builder.maxTokens(settings.maxTokens())
                    .reasoningEffort(settings.reasoningEffort());
        }
        return builder.build();
    }

    /** 接口固定返回前 20% + *** + 后 20%，配置状态依据数据库原值。 */
    private ModelConfigVO toVo(ModelConfig modelConfig) {
        boolean configured = (modelConfig.getApiKey() != null && !modelConfig.getApiKey().isBlank());
        return ModelConfigVO.builder()
                .id(modelConfig.getId())
                .modelName(modelConfig.getModelName())
                .baseUrl(modelConfig.getBaseUrl())
                .apiKey(modelConfig.getMaskedApiKey())
                .provider(modelConfig.getProvider())
                .credentialConfigured(configured)
                .build();
    }

    /** 请求带了可用的 API Key（三态判断：带 = 替换，不带 = 保留）。 */
    private static boolean hasCredential(ModelConfigCommand command) {
        return command.apiKey() != null && !command.apiKey().isBlank();
    }
}
