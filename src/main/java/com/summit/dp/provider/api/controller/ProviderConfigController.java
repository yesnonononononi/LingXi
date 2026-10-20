package com.summit.dp.provider.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.provider.api.dto.ProviderConfigRequest;
import com.summit.dp.provider.application.command.ProviderConfigCommand;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** 提供商配置预设接口；模型侧通过 {@link ProviderConfigService} 注入聚合。 */
@RestController
@RequestMapping("/provider")
@RequiredArgsConstructor
public class ProviderConfigController {

    private final ProviderConfigService service;

    @GetMapping("/list")
    public Result<List<ProviderConfigVO>> list() {
        return service.listAll();
    }

    @GetMapping("/find/{id}")
    public Result<ProviderConfigVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody ProviderConfigRequest request) {
        return service.add(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody ProviderConfigRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.del(id);
    }

    private ProviderConfigCommand toCommand(ProviderConfigRequest request) {
        return new ProviderConfigCommand(request.id(), request.name(), request.icon(),
                request.baseUrl(), request.apiKey(), request.sortOrder());
    }
}
