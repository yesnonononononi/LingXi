package com.summit.dp.provider.application.service.impl;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.provider.application.command.ProviderConfigCommand;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.provider.domain.model.ProviderConfig;
import com.summit.dp.provider.domain.repo.ProviderConfigRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class ProviderConfigServiceImpl implements ProviderConfigService {

    private final ProviderConfigRepository repository;

    @Override
    public Result<Long> add(ProviderConfigCommand command) {
        throwIf(command == null, "提供商配置不能为空");
        ProviderConfig config = new ProviderConfig();
        config.changeName(command.name());
        throwIf(repository.existsByName(config.getName(), null), "提供商名称已存在: " + config.getName());
        config.changeIcon(command.icon());
        config.changeBaseUrl(command.baseUrl());
        config.changeApiKey(command.apiKey() == null ? "" : command.apiKey().trim());
        config.changeSortOrder(command.sortOrder());
        return Result.success(repository.saveAndReturnId(config));
    }

    @Override
    public Result<Void> update(ProviderConfigCommand command) {
        throwIf(command == null || command.id() == null, "修改提供商必须提供提供商标识");
        ProviderConfig config = repository.findById(command.id()).orElseThrow(ClientException::new);
        if (command.name() != null) {
            config.changeName(command.name());
            throwIf(repository.existsByName(config.getName(), command.id()),
                    "提供商名称已存在: " + config.getName());
        }
        if (command.icon() != null) config.changeIcon(command.icon());
        if (command.baseUrl() != null) config.changeBaseUrl(command.baseUrl());
        if (command.apiKey() != null) {
            // 编辑留空保留原值；回传掩码不能写成实际密钥。
            String apiKey = command.apiKey().trim();
            if (apiKey.isEmpty() || apiKey.equals(config.getMaskedApiKey())) apiKey = config.getApiKey();
            config.changeApiKey(apiKey);
        }
        if (command.sortOrder() != null) config.changeSortOrder(command.sortOrder());
        repository.updateById(config);
        return Result.success();
    }

    @Override
    public Result<Void> del(Long id) {
        ProviderConfig config = repository.findById(id).orElseThrow(ClientException::new);
        // 只删预设本身：模型行的 provider_config_id 保留为悬空引用，聚合查询查不到归属即显示「未分组」。
        repository.delete(config);
        return Result.success();
    }

    @Override
    public Result<List<ProviderConfigVO>> listAll() {
        return Result.success(findAllViews());
    }

    @Override
    public Result<ProviderConfigVO> findById(Long id) {
        ProviderConfig config = repository.findById(id).orElseThrow(ClientException::new);
        return Result.success(toVo(config));
    }

    @Override
    public List<ProviderConfigVO> findAllViews() {
        return repository.findAll().stream().map(this::toVo).toList();
    }

    @Override
    public Optional<String> findApiKey(Long id) {
        if (id == null) return Optional.empty();
        return repository.findById(id).map(ProviderConfig::getApiKey);
    }

    private ProviderConfigVO toVo(ProviderConfig config) {
        return ProviderConfigVO.builder()
                .id(config.getId())
                .name(config.getName())
                .icon(config.getIcon())
                .baseUrl(config.getBaseUrl())
                .apiKey(config.getMaskedApiKey())
                .sortOrder(config.getSortOrder())
                .credentialConfigured(config.getApiKey() != null && !config.getApiKey().isBlank())
                .build();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
