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

/** 模型持久化密钥来源；提供方密钥仅在使用时读取，对外只返回掩码。 */
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
        boolean useProvider = command.useProvider() != null ? command.useProvider()
                : providerConfigId != null && providerConfigId > 0;
        if (useProvider) providerApiKey(providerConfigId);
        String apiKey = useProvider || command.apiKey() == null ? "" : command.apiKey().trim();
        ModelConfig modelConfig = new ModelConfig();
        modelConfig.changeModelName(command.modelName());
        modelConfig.changeBaseUrl(command.baseUrl());
        modelConfig.changeApiKey(apiKey);
        modelConfig.changeVision(command.vision());
        modelConfig.changeProviderConfigId(providerConfigId);
        modelConfig.changeUseProvider(useProvider);
        modelConfigRepository.save(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> update(ModelConfigCommand command) {
        throwIf(command == null || command.id() == null, "修改模型必须提供模型标识");
        ModelConfig modelConfig = modelConfigRepository.findById(command.id()).orElseThrow(ClientException::new);
        boolean useProvider = command.useProvider() != null ? command.useProvider() : modelConfig.isUseProvider();
        Long providerConfigId = command.providerConfigId() != null
                ? requireProviderIfPresent(command.providerConfigId())
                : modelConfig.getProviderConfigId();
        String apiKey;
        if (useProvider) {
            providerApiKey(providerConfigId);
            apiKey = "";
        } else {
            // 编辑留空保留原值，清除仍走独立接口。
            apiKey = hasCredential(command) ? command.apiKey().trim() : modelConfig.getApiKey();
            // 客户端回传展示值时不能把掩码写成实际密钥。
            if (apiKey != null && apiKey.equals(modelConfig.getMaskedApiKey())) apiKey = modelConfig.getApiKey();
        }
        if (command.modelName() != null) modelConfig.changeModelName(command.modelName());
        if (command.baseUrl() != null) modelConfig.changeBaseUrl(command.baseUrl());
        if (useProvider || command.apiKey() != null) modelConfig.changeApiKey(apiKey);
        if (command.vision() != null) modelConfig.changeVision(command.vision());
        if (command.providerConfigId() != null) modelConfig.changeProviderConfigId(providerConfigId);
        if (command.useProvider() != null) modelConfig.changeUseProvider(command.useProvider());
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
        modelConfig.changeUseProvider(false);
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

        String apiKey = resolveApiKey(model);
        throwIf(model.getBaseUrl() == null || model.getBaseUrl().isBlank()
                || apiKey == null || apiKey.isBlank()
                || model.getModelName() == null || model.getModelName().isBlank(), "模型连接配置不完整: " + id);
        return RuntimeModel.create(model.getBaseUrl(), apiKey, model.getModelName(), model.getProvider(),
                model.isVision(), settings, chatProperties.getTimeout(), resolveCompactModel(settings));
    }

    /** 专用模型被删除时沿用对话模型；指定提供方的密钥失效必须报错。 */
    private RuntimeModel.CompactModel resolveCompactModel(SettingsView settings) {
        Long compactModelId = settings == null ? null : settings.compactModelId();
        if (compactModelId == null) {
            return null;
        }
        ModelConfig compact = modelConfigRepository.findById(compactModelId).orElse(null);
        if (compact == null) {
            log.warn("专用压缩模型不存在，已回落到对话模型: compactModelId={}", compactModelId);
            return null;
        }
        String apiKey = resolveApiKey(compact);
        if (isBlank(compact.getBaseUrl()) || isBlank(apiKey) || isBlank(compact.getModelName())) {
            log.warn("专用压缩模型连接配置不完整，已回落到对话模型: compactModelId={}", compactModelId);
            return null;
        }
        return new RuntimeModel.CompactModel(compact.getBaseUrl(), apiKey, compact.getModelName());
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
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

    private String resolveApiKey(ModelConfig model) {
        return model.isUseProvider() ? providerApiKey(model.getProviderConfigId()) : model.getApiKey();
    }

    /** 指定提供方后必须取得其当前密钥，不能使用模型残留的旧值。 */
    private String providerApiKey(Long providerConfigId) {
        throwIf(providerConfigId == null || providerConfigId <= 0, "使用提供方密钥时必须指定提供方");
        return providerConfigService.findApiKey(providerConfigId)
                .filter(key -> key != null && !key.isBlank())
                .orElseThrow(() -> new ClientException("提供方未配置 API Key: " + providerConfigId));
    }

    /** 列表允许展示失效配置，运行时再明确报错。 */
    private ModelConfigVO toVo(ModelConfig modelConfig, ProviderConfigVO provider) {
        boolean configured = modelConfig.isUseProvider()
                ? provider != null && provider.isCredentialConfigured()
                : !isBlank(modelConfig.getApiKey());
        return ModelConfigVO.builder()
                .id(modelConfig.getId())
                .modelName(modelConfig.getModelName())
                .baseUrl(modelConfig.getBaseUrl())
                .apiKey(modelConfig.isUseProvider() ? (provider == null ? null : provider.getApiKey()) : modelConfig.getMaskedApiKey())
                .provider(modelConfig.getProvider())
                .providerConfigId(modelConfig.getProviderConfigId())
                .providerName(provider == null ? null : provider.getName())
                .providerIcon(provider == null ? null : provider.getIcon())
                .vision(modelConfig.isVision())
                .useProvider(modelConfig.isUseProvider())
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
