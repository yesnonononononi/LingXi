package com.summit.dp.model.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.service.ModelService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 设置接口：承载与「实例设置」相关的显式动作。
 *
 * <p><b>为何只有 DELETE</b>：设置的读/写入口按既定决策收敛在
 * {@code GET /config/current} 与 {@code POST /config/current/update}
 * （前端已在用，语义也满足单实例），本类不重复提供 GET/PATCH 形态。</p>
 *
 * <p><b>凭据三态（★ 已决策）</b>：「保留」与「清除」是两个不同的 HTTP 动作，
 * 不再靠空值语义区分 —— 编辑模型不带 {@code apiKey} 字段 = 保留；
 * 带新值 = 替换；本端点 = 清除。</p>
 */
@RestController
@RequestMapping("/settings")
@RequiredArgsConstructor
public class SettingsController {
    private final ModelService modelService;

    /** 清除指定模型的 API 凭据；模型不存在时返回业务错误，不做静默成功。 */
    @DeleteMapping("/model/credential")
    public Result<Void> clearModelCredential(@RequestParam Long id) {
        return modelService.clearCredential(id);
    }
}
