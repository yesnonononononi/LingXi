package com.summit.dp.model.application.service;

import com.summit.dp.model.application.command.BatchModelCommand;
import com.summit.dp.model.application.vo.BatchModelResult;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** 批次复用提供商连接；重复名称跳过，任一写入失败则整批回滚。 */
@Service
@RequiredArgsConstructor
public class BatchModelService {
    public static final int MAX_BATCH_SIZE = 200;
    private final ModelConfigRepository repository;
    private final ProviderConfigService providerService;

    @Transactional(rollbackFor = Exception.class)
    public BatchModelResult add(BatchModelCommand command) {
        throwIf(command == null || command.providerConfigId() == null, "批量添加必须选择提供商");
        throwIf(command.modelNames() == null || command.modelNames().isEmpty(), "请至少填写一个模型名称");
        throwIf(command.modelNames().size() > MAX_BATCH_SIZE, "单次最多添加 " + MAX_BATCH_SIZE + " 个模型");
        throwIf(command.vision() == null, "请明确选择模型是否支持图片输入");
        ProviderConfigVO provider = providerService.findAllViews().stream()
                .filter(item -> command.providerConfigId().equals(item.getId())).findFirst().orElseThrow(ClientException::new);
        throwIf(provider.getBaseUrl() == null || provider.getBaseUrl().isBlank(), "请先为提供商配置 API Base URL");
        String key = providerService.findApiKey(provider.getId()).orElseThrow(ClientException::new);
        throwIf(key.isBlank(), "请先为提供商配置 API Key");

        List<ModelConfig> candidates = new ArrayList<>();
        Set<String> requestedNames = new LinkedHashSet<>();
        for (String name : command.modelNames()) {
            throwIf(name == null || name.isBlank(), "模型名称不能为空");
            throwIf(name.trim().length() > ModelConfig.MODEL_NAME_MAX_LENGTH, "模型名称不能超过 " + ModelConfig.MODEL_NAME_MAX_LENGTH + " 个字符");
            if (!requestedNames.add(name.trim())) continue;
            ModelConfig model = new ModelConfig();
            model.changeModelName(name);
            model.changeBaseUrl(provider.getBaseUrl());
            model.changeApiKey(key);
            model.changeProviderConfigId(provider.getId());
            model.changeVision(command.vision());
            candidates.add(model);
        }

        // 全量读取先取得仓储事务锁，再判重和写入，避免并发批次同时插入同名模型。
        Set<String> existingNames = new LinkedHashSet<>();
        for (ModelConfig existing : repository.findAll()) {
            if (provider.getId().equals(existing.getProviderConfigId())) existingNames.add(existing.getModelName());
        }
        List<String> skipped = new ArrayList<>();
        int added = 0;
        for (ModelConfig model : candidates) {
            if (existingNames.contains(model.getModelName())) {
                skipped.add(model.getModelName());
                continue;
            }
            repository.save(model);
            added++;
        }
        return new BatchModelResult(added, skipped);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
