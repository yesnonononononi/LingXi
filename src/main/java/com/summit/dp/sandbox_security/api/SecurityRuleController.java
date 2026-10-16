package com.summit.dp.sandbox_security.api;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.application.SecurityRuleService.SaveRules;
import com.summit.dp.sandbox_security.application.SecurityRuleService.SecurityRuleView;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.List;

@RestController
@RequestMapping("/sandbox/security")
@RequiredArgsConstructor
public class SecurityRuleController {
    private final SecurityRuleService service;
    @GetMapping("/{category}") public Result<SecurityRuleView> current(@PathVariable String category) {
        return Result.success(service.current(category));
    }
    @PutMapping("/{category}") public Result<SecurityRuleView> save(@PathVariable String category, @RequestBody SaveRules request) {
        return Result.success(service.save(category, request));
    }
    @PostMapping("/{category}/defaults") public Result<List<SecurityRule>> defaults(@PathVariable String category) {
        return Result.success(service.defaults(category));
    }
}
