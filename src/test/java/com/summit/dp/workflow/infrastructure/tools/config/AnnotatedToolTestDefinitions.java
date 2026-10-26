package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.tool.AnnotationToolDefinitionFactory;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;

import static org.junit.jupiter.api.Assertions.assertNotNull;

public final class AnnotatedToolTestDefinitions {
    private AnnotatedToolTestDefinitions() {
    }

    public static <T extends ToolExecutor> ToolDefinition<T> create(Class<?> declaredType, T executor) {
        Tool declaration = declaredType.getAnnotation(Tool.class);
        assertNotNull(declaration, () -> declaredType.getName() + " 缺少工具声明");
        return new AnnotationToolDefinitionFactory(new ObjectMapper()).create(declaration, executor);
    }
}
