package com.summit.dp.model.application.service;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.application.vo.ProviderModelGroupVO;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.shared.exception.ClientException;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 模型配置与 API Key 明文保存到数据库；对外 VO 统一返回掩码。
 *
 * <p>模型归属的提供商预设不在本模块维护：跨模块只读注入 {@link ProviderConfigService}，
 * 聚合出「提供商 → 模型」视图。选择模型本身仍以 model_config.id 为准。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ModelServiceImpl implements ModelService {
    private final ModelConfigRepository modelConfigRepository;
    private final ProviderConfigService providerConfigService;
    private final AgentChatProperties chatProperties;

    @Override
    public Result<Void> add(ModelConfigCommand command) {
        throwIf(command == null, "模型配置不能为空");
        throwIf(command.vision() == null, "请明确选择模型是否支持图片输入");
        Long providerConfigId = requireProviderIfPresent(command.providerConfigId());
        // 勾选「使用提供方密钥」时在落库这一刻复制明文：模型行自带密钥，后续运行期不再回落。
        String apiKey = Boolean.TRUE.equals(command.useProviderApiKey())
                ? providerApiKey(providerConfigId)
                : (command.apiKey() == null ? "" : command.apiKey().trim());
        ModelConfig modelConfig = new ModelConfig();
        modelConfig.changeModelName(command.modelName());
        modelConfig.changeBaseUrl(command.baseUrl());
        modelConfig.changeApiKey(apiKey);
        modelConfig.changeVision(command.vision());
        modelConfig.changeProviderConfigId(providerConfigId);
        modelConfigRepository.save(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> update(ModelConfigCommand command) {
        throwIf(command == null || command.id() == null, "修改模型必须提供模型标识");
        ModelConfig modelConfig = modelConfigRepository.findById(command.id()).orElseThrow(ClientException::new);
        boolean useProviderKey = Boolean.TRUE.equals(command.useProviderApiKey());
        Long providerConfigId = command.providerConfigId() != null
                ? requireProviderIfPresent(command.providerConfigId())
                : modelConfig.getProviderConfigId();
        String apiKey;
        if (useProviderKey) {
            apiKey = providerApiKey(providerConfigId);
        } else {
            // 编辑留空保留原值，清除仍走独立接口。
            apiKey = hasCredential(command) ? command.apiKey().trim() : modelConfig.getApiKey();
            // 客户端回传展示值时不能把掩码写成实际密钥。
            if (apiKey != null && apiKey.equals(modelConfig.getMaskedApiKey())) apiKey = modelConfig.getApiKey();
        }
        if (command.modelName() != null) modelConfig.changeModelName(command.modelName());
        if (command.baseUrl() != null) modelConfig.changeBaseUrl(command.baseUrl());
        if (useProviderKey || command.apiKey() != null) modelConfig.changeApiKey(apiKey);
        if (command.vision() != null) modelConfig.changeVision(command.vision());
        if (command.providerConfigId() != null) modelConfig.changeProviderConfigId(providerConfigId);
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
        Map<Long, ProviderConfigVO> providers = providerIndex();
        PageResult<ModelConfigVO> result = new PageResult<>(
                pRes.getCurrent(),
                pRes.getSize(),
                pRes.getTotal(),
                pRes.getRecords().stream().map(model -> toVo(model, providers.get(model.getProviderConfigId()))).toList());
        return Result.success(result);
    }

    @Override
    public Result<ModelConfigVO> findById(Long id) {
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        return Result.success(toVo(modelConfig, providerIndex().get(modelConfig.getProviderConfigId())));
    }

    @Override
    public Result<List<ProviderModelGroupVO>> catalog() {
        List<ProviderConfigVO> providers = providerConfigService.findAllViews();
        Map<Long, List<ModelConfig>> grouped = new LinkedHashMap<>();
        List<ModelConfig> ungrouped = new ArrayList<>();
        Map<Long, ProviderConfigVO> providerById = new LinkedHashMap<>();
        for (ProviderConfigVO provider : providers) {
            if (provider.getId() != null) providerById.put(provider.getId(), provider);
        }
        for (ModelConfig model : modelConfigRepository.findAll()) {
            Long providerId = model.getProviderConfigId();
            if (providerId != null && providerById.containsKey(providerId)) {
                grouped.computeIfAbsent(providerId, key -> new ArrayList<>()).add(model);
            } else {
                // 悬空引用（预设已删除）也落这里，避免出现「没有归属组却挂着模型」的幽灵条目。
                ungrouped.add(model);
            }
        }

        List<ProviderModelGroupVO> groups = new ArrayList<>();
        for (ProviderConfigVO provider : providers) {
            List<ModelConfigVO> models = sortedModels(grouped.get(provider.getId()), provider);
            groups.add(ProviderModelGroupVO.builder()
                    .providerConfigId(provider.getId())
                    .providerName(provider.getName())
                    .providerIcon(provider.getIcon())
                    .baseUrl(provider.getBaseUrl())
                    .modelCount(models.size())
                    .models(models)
                    .build());
        }
        if (!ungrouped.isEmpty()) {
            List<ModelConfigVO> models = sortedModels(ungrouped, null);
            groups.add(ProviderModelGroupVO.builder()
                    .providerName(null)
                    .modelCount(models.size())
                    .models(models)
                    .build());
        }
        return Result.success(groups);
    }

    @Override
    public Result<Void> clearCredential(Long id) {
        // 模型必须存在：清除不存在模型的凭据要报错而不是静默成功（设计要求）。
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        modelConfig.changeApiKey("");
        modelConfigRepository.updateById(modelConfig);
        return Result.success();
    }

    @Override
    public com.summit.core.conf.ModelConfig runtimeConfig(Long id,SettingsView settings) {
        return resolveRuntimeConfig(id, settings).config();
    }

    @Override
    public RuntimeModel resolveRuntimeConfig(Long id, SettingsView settings) {
        throwIf(id == null, "未配置可用的模型连接");

        ModelConfig model = modelConfigRepository.findById(id).orElseThrow(ClientException::new);

        throwIf(model.getBaseUrl() == null || model.getBaseUrl().isBlank()
                || model.getApiKey() == null || model.getApiKey().isBlank()
                || model.getModelName() == null || model.getModelName().isBlank(), "模型连接配置不完整: " + id);
        return RuntimeModel.create(model.getBaseUrl(), model.getApiKey(), model.getModelName(), model.getProvider(),
                model.isVision(), settings, chatProperties.getTimeout());
    }

    /** 分组内按模型名排序：同一提供商的模型较多时，字母序比插入序更可预期。 */
    private List<ModelConfigVO> sortedModels(List<ModelConfig> models, ProviderConfigVO provider) {
        if (models == null || models.isEmpty()) return List.of();
        return models.stream()
                .sorted(Comparator.comparing(model -> model.getModelName() == null ? "" : model.getModelName()))
                .map(model -> toVo(model, provider))
                .toList();
    }

    private Map<Long, ProviderConfigVO> providerIndex() {
        return providerConfigService.findAllViews().stream()
                .filter(provider -> provider.getId() != null)
                .collect(Collectors.toMap(ProviderConfigVO::getId, Function.identity(), (first, second) -> first));
    }

    /** 新增/更新时显式指定的提供商必须存在；{@code 0} 表示解除归属，不做存在性校验。 */
    private Long requireProviderIfPresent(Long providerConfigId) {
        if (providerConfigId == null || providerConfigId <= 0) return providerConfigId;
        boolean exists = providerConfigService.findAllViews().stream()
                .anyMatch(provider -> providerConfigId.equals(provider.getId()));
        throwIf(!exists, "提供商配置不存在: " + providerConfigId);
        return providerConfigId;
    }

    /**
     * 取提供商预设的明文密钥用于复制。
     *
     * <p>复制发生在写模型行时，模型自此持有自己的密钥；运行期不再需要「模型没配就借提供方的」
     * 那种降级分支——降级分支恰恰是最容易在重启/换 key 后失配的地方。</p>
     */
    private String providerApiKey(Long providerConfigId) {
        throwIf(providerConfigId == null || providerConfigId <= 0, "使用提供方密钥时必须指定提供方");
        return providerConfigService.findApiKey(providerConfigId)
                .filter(key -> key != null && !key.isBlank())
                .orElseThrow(() -> new ClientException("提供方未配置 API Key: " + providerConfigId));
    }

    /** 接口固定返回前 20% + *** + 后 20%，配置状态依据数据库原值。 */
    private ModelConfigVO toVo(ModelConfig modelConfig, ProviderConfigVO provider) {
        boolean configured = (modelConfig.getApiKey() != null && !modelConfig.getApiKey().isBlank());
        return ModelConfigVO.builder()
                .id(modelConfig.getId())
                .modelName(modelConfig.getModelName())
                .baseUrl(modelConfig.getBaseUrl())
                .apiKey(modelConfig.getMaskedApiKey())
                .provider(modelConfig.getProvider())
                .providerConfigId(provider == null ? null : provider.getId())
                .providerName(provider == null ? null : provider.getName())
                .providerIcon(provider == null ? null : provider.getIcon())
                .vision(modelConfig.isVision())
                .credentialConfigured(configured)
                .build();
    }

    /** 请求带了可用的 API Key（三态判断：带 = 替换，不带 = 保留）。 */
    private static boolean hasCredential(ModelConfigCommand command) {
        return command.apiKey() != null && !command.apiKey().isBlank();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
