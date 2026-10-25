package com.summit.dp.execution;

import com.summit.core.conf.SensitiveDataSpec;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 普通编排测试只替换版本库；真实冻结语义由数据库集成用例验证。 */
public final class RuntimeConfigurationTestSupport {
    private RuntimeConfigurationTestSupport() { }

    public static RuntimeConfigurationService create() {
        RuntimeConfigurationService service = mock(RuntimeConfigurationService.class);
        when(service.freezeModel(any(), any())).thenAnswer(invocation -> {
            Long id = invocation.getArgument(0);
            return SensitiveDataSpec.builder().id(id == null ? 1L : id).version(1).build();
        });
        when(service.freezeMcp(any())).thenAnswer(invocation -> invocation.getArgument(0) == null ? null
                : SensitiveDataSpec.builder().id(1L).version(1).build());
        return service;
    }
}
