package com.summit.dp.sandbox_security.infrastructure.persistence;

import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import java.util.List;

/** 三类本地表采用相同结构，分别落盘，不能混入通用配置。 */
public record SecurityRuleSetPO(Long id, long revision, List<SecurityRule> rules) { }
