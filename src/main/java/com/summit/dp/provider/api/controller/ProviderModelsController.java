package com.summit.dp.provider.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.provider.api.dto.ProviderModelsRequest;
import com.summit.dp.provider.application.service.ProviderModelDiscoveryService;
import com.summit.dp.provider.application.vo.RemoteModelVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/provider/models")
@RequiredArgsConstructor
public class ProviderModelsController {
    private final ProviderModelDiscoveryService service;

    @PostMapping("/discover")
    public Result<List<RemoteModelVO>> discover(@RequestBody ProviderModelsRequest request) {
        return Result.success(service.discover(request.providerConfigId(), request.baseUrl(), request.apiKey()));
    }
}
